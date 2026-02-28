import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

function norm(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

type SwapRow = { block_timestamp: string; activity_type: string | null; amount_usdc: number | null };

function floorToBucket(d: Date, minutes: number) {
  const ms = minutes * 60 * 1000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

async function buildChartPng(input: {
  coinAddress: string;
  hours: number;
  bucketMinutes: number;
  outFile: string;
}) {
  const addr = norm(input.coinAddress);
  const hours = Math.max(1, Math.min(168, Number(input.hours || 24)));
  const bucketMinutes = Math.max(1, Math.min(60, Number(input.bucketMinutes || 15)));

  const coin = db.prepare(`SELECT address, symbol, name FROM coins WHERE address = ?`).get(addr) as any;
  if (!coin) throw new Error(`coin not found: ${addr}`);

  const rows = db.prepare(`
    SELECT block_timestamp, activity_type, amount_usdc
    FROM coin_swaps
    WHERE coin_address = ?
      AND datetime(block_timestamp) >= datetime('now', ?)
    ORDER BY datetime(block_timestamp) ASC
  `).all(addr, `-${hours} hours`) as SwapRow[];

  if (!rows.length) throw new Error(`no swaps in last ${hours}h for ${addr}`);

  const bins = new Map<string, { buy: number; sell: number; count: number; usd: number }>();

  for (const r of rows) {
    const dt = new Date(r.block_timestamp);
    if (Number.isNaN(dt.getTime())) continue;
    const b = floorToBucket(dt, bucketMinutes);
    const key = b.toISOString();
    const row = bins.get(key) ?? { buy: 0, sell: 0, count: 0, usd: 0 };
    row.count += 1;
    if ((r.activity_type ?? "").toUpperCase() === "BUY") row.buy += 1;
    else if ((r.activity_type ?? "").toUpperCase() === "SELL") row.sell += 1;
    row.usd += Number(r.amount_usdc ?? 0);
    bins.set(key, row);
  }

  const keys = [...bins.keys()].sort();
  const labels: string[] = [];
  const swaps: number[] = [];
  const buyPct: number[] = [];
  for (const k of keys) {
    const b = bins.get(k)!;
    labels.push(new Date(k).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    swaps.push(b.count);
    const totalSide = Math.max(1, b.buy + b.sell);
    buyPct.push(Math.round((b.buy / totalSide) * 100));
  }

  const title = `${coin.symbol || coin.name || shortAddr(addr)}  •  ${hours}h activity`; 
  const avgBuy = Math.round(buyPct.reduce((a, b) => a + b, 0) / Math.max(1, buyPct.length));
  const peak = Math.max(...swaps);
  const subtitle = `${shortAddr(addr)} • ${rows.length} swaps • ${bucketMinutes}m bins • avg buy ${avgBuy}% • peak ${peak}/bin`;

  const chartConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Swaps/bin",
          data: swaps,
          yAxisID: "y",
          backgroundColor: "rgba(37, 99, 235, 0.35)",
          borderColor: "rgba(37, 99, 235, 0.85)",
          borderWidth: 1,
        },
        {
          type: "line",
          label: "Buy %",
          data: buyPct,
          yAxisID: "y1",
          borderColor: "rgba(34, 197, 94, 0.95)",
          backgroundColor: "rgba(34, 197, 94, 0.0)",
          fill: false,
          borderWidth: 3,
          pointRadius: 0,
          lineTension: 0.25,
        },
      ],
    },
    options: {
      legend: { position: "bottom", labels: { boxWidth: 36, fontSize: 14 } },
      title: {
        display: true,
        text: [title, subtitle],
        fontSize: 16,
        padding: 12,
      },
      layout: { padding: { left: 12, right: 16, top: 6, bottom: 8 } },
      scales: {
        xAxes: [
          {
            ticks: { maxTicksLimit: 12, fontSize: 14 },
            gridLines: { display: false },
          },
        ],
        yAxes: [
          {
            id: "y",
            position: "left",
            scaleLabel: { display: true, labelString: "Swaps/bin", fontSize: 15 },
            ticks: { beginAtZero: true, max: Math.max(...swaps) + 40, fontSize: 14 },
          },
          {
            id: "y1",
            position: "right",
            scaleLabel: { display: true, labelString: "Buy %", fontSize: 15 },
            ticks: { min: 0, max: 100, fontSize: 14 },
            gridLines: { drawOnChartArea: false },
          },
        ],
      },
      annotation: {
        annotations: [
          {
            type: "line",
            mode: "horizontal",
            scaleID: "y1",
            value: 50,
            borderColor: "rgba(34,197,94,0.4)",
            borderWidth: 1,
            borderDash: [6, 4],
          },
        ],
      },
    },
  };

  const res = await fetch("https://quickchart.io/chart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      width: 1400,
      height: 800,
      format: "png",
      backgroundColor: "white",
      chart: chartConfig,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`quickchart failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(input.outFile), { recursive: true });
  fs.writeFileSync(input.outFile, buf);

  return {
    outFile: input.outFile,
    symbol: coin.symbol ?? null,
    name: coin.name ?? null,
    coinAddress: addr,
    points: labels.length,
    swaps: rows.length,
  };
}

async function main() {
  const coinAddress = process.argv[2];
  if (!coinAddress) throw new Error("Usage: tsx src/chart.ts <coin_address> [hours=24] [bucketMinutes=15] [outFile]");
  const hours = Number(process.argv[3] ?? 24);
  const bucketMinutes = Number(process.argv[4] ?? 15);
  const defaultOutDir = fs.existsSync('/Users/user/.openclaw/media')
    ? '/Users/user/.openclaw/media'
    : './tmp';
  const outFile = process.argv[5] ?? `${defaultOutDir}/chart-${norm(coinAddress)}.png`;
  const result = await buildChartPng({ coinAddress, hours, bucketMinutes, outFile });
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
