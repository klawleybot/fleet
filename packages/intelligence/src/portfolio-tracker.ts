/**
 * portfolio-tracker.ts — Track Klawley SA portfolio value over time
 *
 * Snapshots the wallet's ETH balance + token holdings value at regular intervals.
 * Generates stacked area charts showing liquid ETH, held tokens, and total.
 *
 * Usage:
 *   bun x tsx src/portfolio-tracker.ts snapshot       — take a snapshot now
 *   bun x tsx src/portfolio-tracker.ts chart [days]   — generate chart (default 7 days)
 *   bun x tsx src/portfolio-tracker.ts history [days]  — print snapshot history
 */

import Database from "better-sqlite3";
import {
  createPublicClient,
  http,
  formatEther,
  erc20Abi,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";
import { estimateSellValue } from "./sell-monitor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, "../.data/zora-intelligence.db");
const CHART_OUTPUT_DIR = resolve(__dirname, "../.data");

const KLAWLEY_SA: Address = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";

// ---------------------------------------------------------------------------
// DB schema
// ---------------------------------------------------------------------------

function getDb(dbPath?: string): Database.Database {
  const db = new Database(dbPath ?? DEFAULT_DB);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      eth_balance_wei TEXT NOT NULL,
      held_value_wei TEXT NOT NULL,
      total_value_wei TEXT NOT NULL,
      eth_price_usd REAL,
      open_positions INTEGER NOT NULL DEFAULT 0,
      holdings_detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_ts
      ON portfolio_snapshots(timestamp);
  `);
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface PortfolioSnapshot {
  timestamp: string;
  ethBalanceWei: bigint;
  heldValueWei: bigint;
  totalValueWei: bigint;
  ethPriceUsd: number | null;
  openPositions: number;
  holdings: { coinAddress: string; symbol: string; tokens: string; valueWei: string }[];
}

// Well-known tokens to always check (beyond open positions)
const KNOWN_TOKENS: { address: Address; symbol: string; priceSource?: "coingecko" }[] = [
  { address: "0x1111111111166b7fe7bd91427724b487980afc69", symbol: "ZORA", priceSource: "coingecko" },
];

async function getTokenPriceEth(
  tokenAddress: Address,
  priceSource: string | undefined,
): Promise<number | null> {
  if (priceSource === "coingecko") {
    try {
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${tokenAddress}&vs_currencies=eth`
      );
      if (resp.ok) {
        const data = await resp.json() as Record<string, { eth?: number }>;
        return data[tokenAddress.toLowerCase()]?.eth ?? null;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export async function takeSnapshot(dbPath?: string): Promise<PortfolioSnapshot> {
  const db = getDb(dbPath);
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  });

  // 1. ETH balance
  const ethBalance = await client.getBalance({ address: KLAWLEY_SA });
  console.log(`[portfolio] ETH balance: ${formatEther(ethBalance)} ETH`);

  // 2. Collect all token addresses to check:
  //    - Open positions from DB
  //    - All unique coins from closed positions (may have residual balances)
  //    - Known tokens (ZORA, etc.)
  const positions = db.prepare(
    "SELECT DISTINCT coin_address, symbol FROM klawley_positions"
  ).all() as { coin_address: string; symbol: string }[];

  // Build deduplicated set of addresses to scan
  const tokenSet = new Map<string, { symbol: string; priceSource?: string }>();
  for (const pos of positions) {
    tokenSet.set(pos.coin_address.toLowerCase(), { symbol: pos.symbol || pos.coin_address.slice(0, 10) });
  }
  for (const kt of KNOWN_TOKENS) {
    tokenSet.set(kt.address.toLowerCase(), { symbol: kt.symbol, priceSource: kt.priceSource });
  }

  console.log(`[portfolio] Scanning ${tokenSet.size} token addresses...`);

  // 3. Check on-chain balances + estimate values
  let totalHeldValue = 0n;
  const holdings: PortfolioSnapshot["holdings"] = [];

  for (const [addr, meta] of tokenSet) {
    try {
      const onChainBalance = await client.readContract({
        address: addr as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [KLAWLEY_SA],
      });

      if (onChainBalance <= 0n) continue;

      let valueWei = 0n;

      // Try quoter first (works for Zora coins with Doppler pools)
      const quoterValue = await estimateSellValue(addr as Address, onChainBalance);
      if (quoterValue !== null && quoterValue > 0n) {
        valueWei = quoterValue;
      } else if (meta.priceSource) {
        // Fall back to price feed (for tokens like ZORA with market prices)
        const priceEth = await getTokenPriceEth(addr as Address, meta.priceSource);
        if (priceEth !== null) {
          const balFloat = Number(formatEther(onChainBalance));
          // Convert to wei: balFloat * priceEth * 1e18
          valueWei = BigInt(Math.floor(balFloat * priceEth * 1e18));
        }
      }

      totalHeldValue += valueWei;

      holdings.push({
        coinAddress: addr,
        symbol: meta.symbol,
        tokens: onChainBalance.toString(),
        valueWei: valueWei.toString(),
      });

      console.log(`  ${meta.symbol}: ${formatEther(onChainBalance)} tokens ≈ ${formatEther(valueWei)} ETH`);
    } catch {
      // Silently skip tokens that fail (non-standard contracts, destroyed, etc.)
    }
  }

  // 4. Get ETH price from CoinGecko
  let ethPriceUsd: number | null = null;
  try {
    const resp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (resp.ok) {
      const data = await resp.json() as { ethereum: { usd: number } };
      ethPriceUsd = data.ethereum.usd;
    }
  } catch {
    ethPriceUsd = null;
  }

  const totalValue = ethBalance + totalHeldValue;

  const snapshot: PortfolioSnapshot = {
    timestamp: new Date().toISOString(),
    ethBalanceWei: ethBalance,
    heldValueWei: totalHeldValue,
    totalValueWei: totalValue,
    ethPriceUsd,
    openPositions: holdings.length,
    holdings,
  };

  // 5. Save to DB
  db.prepare(`
    INSERT INTO portfolio_snapshots (timestamp, eth_balance_wei, held_value_wei, total_value_wei, eth_price_usd, open_positions, holdings_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.timestamp,
    ethBalance.toString(),
    totalHeldValue.toString(),
    totalValue.toString(),
    ethPriceUsd,
    holdings.length,
    JSON.stringify(holdings),
  );

  console.log(`[portfolio] Snapshot saved: total ${formatEther(totalValue)} ETH ($${ethPriceUsd ? (Number(formatEther(totalValue)) * ethPriceUsd).toFixed(2) : "?"})`)

  db.close();
  return snapshot;
}

// ---------------------------------------------------------------------------
// Chart generation (HTML with inline Chart.js)
// ---------------------------------------------------------------------------

interface SnapshotRow {
  timestamp: string;
  eth_balance_wei: string;
  held_value_wei: string;
  total_value_wei: string;
  eth_price_usd: number | null;
  open_positions: number;
}

export function generateChart(days = 7, dbPath?: string): string {
  const db = getDb(dbPath);
  // Cap at 7 days
  const cappedDays = Math.min(days, 7);
  const cutoff = new Date(Date.now() - cappedDays * 24 * 60 * 60 * 1000).toISOString();

  let rows = db.prepare(`
    SELECT timestamp, eth_balance_wei, held_value_wei, total_value_wei, eth_price_usd, open_positions
    FROM portfolio_snapshots
    WHERE timestamp >= ?
    ORDER BY timestamp ASC
  `).all(cutoff) as SnapshotRow[];

  db.close();

  if (rows.length === 0) {
    console.log("[portfolio] No snapshots found for chart generation.");
    return "";
  }

  // Downsample if too many points (target ~168 max = 1 per hour for 7 days)
  const MAX_POINTS = 168;
  if (rows.length > MAX_POINTS) {
    const step = Math.ceil(rows.length / MAX_POINTS);
    const sampled: SnapshotRow[] = [];
    for (let i = 0; i < rows.length; i += step) {
      sampled.push(rows[i]);
    }
    // Always include the last point
    if (sampled[sampled.length - 1] !== rows[rows.length - 1]) {
      sampled.push(rows[rows.length - 1]);
    }
    rows = sampled;
  }

  // Convert to chart data — USD is the primary view
  const labels = rows.map(r => {
    const d = new Date(r.timestamp);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  });

  const ethLiquid = rows.map(r => Number(formatEther(BigInt(r.eth_balance_wei))));
  const ethHeld = rows.map(r => Number(formatEther(BigInt(r.held_value_wei))));

  // USD conversion — use per-row eth_price_usd (backfilled or live)
  const usdLiquid = rows.map((r, i) => {
    const price = r.eth_price_usd ?? 2050; // fallback estimate
    return ethLiquid[i] * price;
  });
  const usdHeld = rows.map((r, i) => {
    const price = r.eth_price_usd ?? 2050;
    return ethHeld[i] * price;
  });

  const lastLiquidUsd = usdLiquid[usdLiquid.length - 1] ?? 0;
  const lastHeldUsd = usdHeld[usdHeld.length - 1] ?? 0;
  const lastTotalUsd = lastLiquidUsd + lastHeldUsd;
  const lastLiquidEth = ethLiquid[ethLiquid.length - 1] ?? 0;
  const lastHeldEth = ethHeld[ethHeld.length - 1] ?? 0;
  const lastTotalEth = lastLiquidEth + lastHeldEth;
  const pointRadius = rows.length > 50 ? 0 : 3;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Klawley Portfolio — ${cappedDays}d</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    body {
      background: #0d1117;
      color: #c9d1d9;
      font-family: -apple-system, 'Segoe UI', Roboto, monospace;
      margin: 0;
      padding: 20px;
    }
    h1 { color: #ff6b6b; font-size: 1.4em; margin-bottom: 4px; }
    .subtitle { color: #8b949e; font-size: 0.9em; margin-bottom: 20px; }
    .chart-container { 
      position: relative; 
      width: 100%; 
      max-width: 1000px; 
      height: 400px;
      margin: 0 auto 30px;
    }
    .stats {
      display: flex;
      gap: 20px;
      justify-content: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .stat {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px 20px;
      text-align: center;
    }
    .stat-value { font-size: 1.3em; font-weight: bold; color: #58a6ff; }
    .stat-label { font-size: 0.8em; color: #8b949e; margin-top: 4px; }
    .stat-value.green { color: #3fb950; }
    .stat-value.red { color: #f85149; }
  </style>
</head>
<body>
  <h1>🦞 Klawley Portfolio</h1>
  <p class="subtitle">SA: ${KLAWLEY_SA} · ${rows.length} data points · ${cappedDays}d window</p>
  
  <div class="stats">
    <div class="stat">
      <div class="stat-value">$${lastLiquidUsd.toFixed(2)}</div>
      <div class="stat-label">Liquid ETH (${lastLiquidEth.toFixed(4)} Ξ)</div>
    </div>
    <div class="stat">
      <div class="stat-value">$${lastHeldUsd.toFixed(2)}</div>
      <div class="stat-label">Held Tokens (${lastHeldEth.toFixed(4)} Ξ)</div>
    </div>
    <div class="stat">
      <div class="stat-value">$${lastTotalUsd.toFixed(2)}</div>
      <div class="stat-label">Total (${lastTotalEth.toFixed(4)} Ξ)</div>
    </div>
  </div>

  <div class="chart-container">
    <canvas id="usdChart"></canvas>
  </div>
  <div class="chart-container">
    <canvas id="ethChart"></canvas>
  </div>

  <script>
    const labels = ${JSON.stringify(labels)};
    const usdLiquid = ${JSON.stringify(usdLiquid)};
    const usdHeld = ${JSON.stringify(usdHeld)};
    const ethLiquid = ${JSON.stringify(ethLiquid)};
    const ethHeld = ${JSON.stringify(ethHeld)};

    // USD chart (primary)
    new Chart(document.getElementById('usdChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Held Tokens',
            data: usdHeld,
            backgroundColor: 'rgba(255, 107, 107, 0.4)',
            borderColor: '#ff6b6b',
            borderWidth: 1.5,
            fill: 'origin',
            tension: 0.3,
            pointRadius: ${pointRadius},
          },
          {
            label: 'Liquid ETH',
            data: usdLiquid.map((v, i) => v + usdHeld[i]),
            backgroundColor: 'rgba(88, 166, 255, 0.4)',
            borderColor: '#58a6ff',
            borderWidth: 1.5,
            fill: '-1',
            tension: 0.3,
            pointRadius: ${pointRadius},
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: { display: true, text: 'Portfolio Value (USD)', color: '#c9d1d9', font: { size: 14 } },
          legend: { labels: { color: '#c9d1d9' } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const idx = ctx.dataIndex;
                if (ctx.datasetIndex === 0) return 'Held: $' + usdHeld[idx].toFixed(2);
                return 'Liquid: $' + usdLiquid[idx].toFixed(2);
              },
              afterBody: (items) => {
                const idx = items[0]?.dataIndex;
                if (idx != null) {
                  const total = usdLiquid[idx] + usdHeld[idx];
                  return 'Total: $' + total.toFixed(2);
                }
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#8b949e', maxRotation: 45, maxTicksLimit: 20 },
            grid: { color: '#21262d' },
          },
          y: {
            ticks: { color: '#8b949e', callback: v => '$' + Number(v).toFixed(0) },
            grid: { color: '#21262d' },
            title: { display: true, text: 'USD', color: '#8b949e' },
            beginAtZero: false,
          },
        },
      },
    });

    // ETH chart (secondary)
    new Chart(document.getElementById('ethChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Held Tokens (ETH value)',
            data: ethHeld,
            backgroundColor: 'rgba(255, 107, 107, 0.4)',
            borderColor: '#ff6b6b',
            borderWidth: 1.5,
            fill: 'origin',
            tension: 0.3,
            pointRadius: ${pointRadius},
          },
          {
            label: 'Liquid ETH',
            data: ethLiquid.map((v, i) => v + ethHeld[i]),
            backgroundColor: 'rgba(88, 166, 255, 0.4)',
            borderColor: '#58a6ff',
            borderWidth: 1.5,
            fill: '-1',
            tension: 0.3,
            pointRadius: ${pointRadius},
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: { display: true, text: 'Portfolio Value (ETH)', color: '#c9d1d9', font: { size: 14 } },
          legend: { labels: { color: '#c9d1d9' } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const idx = ctx.dataIndex;
                if (ctx.datasetIndex === 0) return 'Held: ' + ethHeld[idx].toFixed(4) + ' Ξ';
                return 'Liquid: ' + ethLiquid[idx].toFixed(4) + ' Ξ';
              },
              afterBody: (items) => {
                const idx = items[0]?.dataIndex;
                if (idx != null) {
                  const total = ethLiquid[idx] + ethHeld[idx];
                  return 'Total: ' + total.toFixed(4) + ' Ξ';
                }
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#8b949e', maxRotation: 45, maxTicksLimit: 20 },
            grid: { color: '#21262d' },
          },
          y: {
            ticks: { color: '#8b949e', callback: v => Number(v).toFixed(3) + ' Ξ' },
            grid: { color: '#21262d' },
            title: { display: true, text: 'ETH', color: '#8b949e' },
            beginAtZero: false,
          },
        },
      },
    });
  </script>
</body>
</html>`;

  const outPath = resolve(CHART_OUTPUT_DIR, "portfolio-chart.html");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`[portfolio] Chart written to ${outPath} (${rows.length} points, ${cappedDays}d)`);
  return outPath;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function printHistory(days = 7, dbPath?: string) {
  const db = getDb(dbPath);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT timestamp, eth_balance_wei, held_value_wei, total_value_wei, eth_price_usd, open_positions
    FROM portfolio_snapshots
    WHERE timestamp >= ?
    ORDER BY timestamp ASC
  `).all(cutoff) as SnapshotRow[];

  db.close();

  if (rows.length === 0) {
    console.log("No snapshots in the last", days, "days.");
    return;
  }

  console.log(`Portfolio history (${rows.length} snapshots, ${days}d):\n`);
  for (const r of rows) {
    const eth = Number(formatEther(BigInt(r.eth_balance_wei)));
    const held = Number(formatEther(BigInt(r.held_value_wei)));
    const total = Number(formatEther(BigInt(r.total_value_wei)));
    const usd = r.eth_price_usd ? ` ($${(total * r.eth_price_usd).toFixed(2)})` : "";
    const ts = r.timestamp.slice(0, 16).replace("T", " ");
    console.log(`  ${ts}  ETH: ${eth.toFixed(4)}  Held: ${held.toFixed(4)}  Total: ${total.toFixed(4)}${usd}  [${r.open_positions} pos]`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [cmd, arg] = process.argv.slice(2);

if (cmd === "snapshot") {
  takeSnapshot().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else if (cmd === "chart") {
  generateChart(parseInt(arg || "7", 10));
} else if (cmd === "history") {
  printHistory(parseInt(arg || "7", 10));
} else {
  console.log("Usage: portfolio-tracker.ts <snapshot|chart [days]|history [days]>");
  process.exit(1);
}
