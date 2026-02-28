import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

function norm(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function floorToBucket(d: Date, minutes: number) {
  const ms = minutes * 60 * 1000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

type SwapRow = {
  block_timestamp: string;
  activity_type: string | null;
  amount_usdc: number | null;
  coin_amount: number | null;
};

function pct(a: number, b: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return ((a - b) / Math.abs(b)) * 100;
}

async function buildDashboard(input: {
  coinAddress: string;
  hours: number;
  bucketMinutes: number;
  outFile: string;
}) {
  const addr = norm(input.coinAddress);
  const hours = Math.max(2, Math.min(168, Number(input.hours || 24)));
  const bucketMinutes = Math.max(1, Math.min(60, Number(input.bucketMinutes || 15)));

  const coin = db.prepare(`
    SELECT address, symbol, name, volume_24h, market_cap, chain_id, raw_json
    FROM coins
    WHERE address = ?
  `).get(addr) as any;
  if (!coin) throw new Error(`coin not found: ${addr}`);

  const analytics = db.prepare(`
    SELECT swap_count_1h, swap_count_prev_1h, net_flow_usdc_1h, momentum_score_1h, momentum_acceleration_1h,
           swap_count_24h, net_flow_usdc_24h, momentum_score
    FROM coin_analytics
    WHERE coin_address = ?
  `).get(addr) as any;

  const swaps = db.prepare(`
    SELECT block_timestamp, activity_type, amount_usdc, coin_amount
    FROM coin_swaps
    WHERE coin_address = ?
      AND datetime(block_timestamp) >= datetime('now', ?)
    ORDER BY datetime(block_timestamp) ASC
  `).all(addr, `-${hours} hours`) as SwapRow[];

  if (!swaps.length) throw new Error(`no swaps in last ${hours}h for ${addr}`);

  const bins = new Map<string, {
    volumeUsd: number;
    buy: number;
    sell: number;
    count: number;
    quoteUsd: number;
    baseAmt: number;
  }>();

  for (const s of swaps) {
    const dt = new Date(s.block_timestamp);
    if (Number.isNaN(dt.getTime())) continue;
    const key = floorToBucket(dt, bucketMinutes).toISOString();
    const row = bins.get(key) ?? { volumeUsd: 0, buy: 0, sell: 0, count: 0, quoteUsd: 0, baseAmt: 0 };

    const usd = Number(s.amount_usdc ?? 0);
    const base = Math.abs(Number(s.coin_amount ?? 0));
    row.volumeUsd += usd;
    row.count += 1;
    if ((s.activity_type ?? "").toUpperCase() === "BUY") row.buy += 1;
    else if ((s.activity_type ?? "").toUpperCase() === "SELL") row.sell += 1;

    if (usd > 0 && base > 0) {
      row.quoteUsd += usd;
      row.baseAmt += base;
    }

    bins.set(key, row);
  }

  const keys = [...bins.keys()].sort();
  const labels: string[] = [];
  const volumeUsd: number[] = [];
  const buyPct: number[] = [];
  const swapsPerBin: number[] = [];

  for (const k of keys) {
    const b = bins.get(k)!;
    labels.push(new Date(k).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    volumeUsd.push(Number(b.volumeUsd.toFixed(2)));
    swapsPerBin.push(b.count);

    const sideTot = Math.max(1, b.buy + b.sell);
    buyPct.push(Math.round((b.buy / sideTot) * 100));
  }

  const coinRaw = (() => {
    try { return JSON.parse(String(coin.raw_json ?? "{}")); }
    catch { return {}; }
  })() as any;
  const latestPrice = Number(coinRaw?.tokenPrice?.priceInUsdc ?? 0);
  const mcap = Number(coin.market_cap ?? 0);

  const half = Math.max(1, Math.floor(volumeUsd.length / 2));
  const volRecent = volumeUsd.slice(-half).reduce((a, b) => a + b, 0);
  const volPrev = volumeUsd.slice(0, half).reduce((a, b) => a + b, 0);
  const volTrendPct = pct(volRecent, Math.max(1, volPrev));

  const trendTag = Number(analytics?.momentum_acceleration_1h ?? 1) > 1.05
    ? "UP"
    : Number(analytics?.momentum_acceleration_1h ?? 1) < 0.95
      ? "DOWN"
      : "FLAT";

  const title = `${coin.symbol || coin.name || shortAddr(addr)} quick-glance dashboard (${hours}h)`;
  const subtitle = [
    `${shortAddr(addr)}`,
    `price $${latestPrice ? latestPrice.toFixed(6) : "n/a"}`,
    `mcap $${mcap.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    `vol24h $${Number(coin.volume_24h ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    `trend ${trendTag} • mom1h ${Number(analytics?.momentum_score_1h ?? 0).toFixed(1)}`,
    `accel ${Number(analytics?.momentum_acceleration_1h ?? 0).toFixed(2)}x`,
    `vol trend ${volTrendPct >= 0 ? "+" : ""}${volTrendPct.toFixed(0)}%`,
  ].join(" • ");

  const chartConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Volume USD/bin",
          data: volumeUsd,
          yAxisID: "yVol",
          backgroundColor: "rgba(59, 130, 246, 0.35)",
          borderColor: "rgba(59, 130, 246, 0.9)",
          borderWidth: 1,
        },
        {
          type: "line",
          label: "Swaps/bin",
          data: swapsPerBin,
          yAxisID: "ySwap",
          borderColor: "rgba(249, 115, 22, 0.95)",
          backgroundColor: "rgba(249, 115, 22, 0.0)",
          fill: false,
          borderWidth: 2,
          pointRadius: 0,
          lineTension: 0.2,
        },
        {
          type: "line",
          label: "Buy %",
          data: buyPct,
          yAxisID: "yBuy",
          borderColor: "rgba(34, 197, 94, 0.95)",
          backgroundColor: "rgba(34, 197, 94, 0.0)",
          fill: false,
          borderWidth: 2,
          pointRadius: 0,
          lineTension: 0.2,
        },
      ],
    },
    options: {
      legend: { position: "bottom", labels: { boxWidth: 34, fontSize: 13 } },
      title: { display: true, text: [title, subtitle], fontSize: 15, padding: 12 },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 12, fontSize: 13 }, gridLines: { display: false } }],
        yAxes: [
          {
            id: "yVol",
            position: "left",
            scaleLabel: { display: true, labelString: "Volume USD/bin", fontSize: 14 },
            ticks: { beginAtZero: true, fontSize: 13 },
          },
          {
            id: "ySwap",
            position: "right",
            scaleLabel: { display: true, labelString: "Swaps/bin", fontSize: 14 },
            ticks: { beginAtZero: true, fontSize: 13 },
            gridLines: { drawOnChartArea: false },
          },
          {
            id: "yBuy",
            position: "right",
            scaleLabel: { display: true, labelString: "Buy %", fontSize: 14 },
            ticks: { min: 0, max: 100, fontSize: 13 },
            gridLines: { drawOnChartArea: false },
          },
        ],
      },
    },
  };

  const res = await fetch("https://quickchart.io/chart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      width: 1500,
      height: 900,
      format: "png",
      backgroundColor: "white",
      chart: chartConfig,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`quickchart failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const png = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(input.outFile), { recursive: true });
  fs.writeFileSync(input.outFile, png);

  return {
    outFile: input.outFile,
    coinAddress: addr,
    symbol: coin.symbol ?? null,
    name: coin.name ?? null,
    latestPriceUsd: latestPrice,
    volume24h: Number(coin.volume_24h ?? 0),
    volTrendPct,
    momentum1h: Number(analytics?.momentum_score_1h ?? 0),
    accel1h: Number(analytics?.momentum_acceleration_1h ?? 0),
  };
}

async function main() {
  const coinAddress = process.argv[2];
  if (!coinAddress) {
    throw new Error("Usage: tsx src/coin-dashboard.ts <coin_address> [hours=24] [bucketMinutes=15] [outFile]");
  }

  const hours = Number(process.argv[3] ?? 24);
  const bucketMinutes = Number(process.argv[4] ?? 15);
  const defaultOutDir = fs.existsSync('/Users/user/.openclaw/media')
    ? '/Users/user/.openclaw/media'
    : './tmp';
  const outFile = process.argv[5] ?? `${defaultOutDir}/dashboard-${norm(coinAddress)}.png`;

  const result = await buildDashboard({ coinAddress, hours, bucketMinutes, outFile });
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
