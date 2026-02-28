import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

function norm(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

function floorToBucket(d: Date, minutes: number) {
  const ms = minutes * 60 * 1000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

type Row = {
  block_timestamp: string;
  amount_decimal: number | null;
  coin_amount: number | null;
};

export function defaultMediaOut(fileName: string) {
  const defaultOutDir = process.env.OPENCLAW_MEDIA_DIR || path.join(process.env.HOME || "/tmp", ".openclaw", "media");
  return path.join(defaultOutDir, fileName);
}

export async function buildPriceVolumeChart(input: {
  coinAddress: string;
  hours?: number;
  bucketMinutes?: number;
  outFile: string;
}) {
  const addr = norm(input.coinAddress);
  const hours = Math.max(1, Math.min(168, Number(input.hours ?? 24)));
  const bucketMinutes = Math.max(1, Math.min(60, Number(input.bucketMinutes ?? 15)));

  const coin = db.prepare(`SELECT symbol, name, address FROM coins WHERE address = ?`).get(addr) as any;
  if (!coin) throw new Error(`coin not found: ${addr}`);

  const rows = db.prepare(`
    SELECT block_timestamp, amount_decimal, coin_amount
    FROM coin_swaps
    WHERE coin_address = ?
      AND datetime(block_timestamp) >= datetime('now', ?)
    ORDER BY datetime(block_timestamp) ASC
  `).all(addr, `-${hours} hours`) as Row[];

  if (!rows.length) throw new Error(`no swap data for ${addr} in last ${hours}h`);

  const bins = new Map<string, { prices: number[]; volumeUsd: number }>();

  for (const r of rows) {
    const ts = new Date(r.block_timestamp);
    if (Number.isNaN(ts.getTime())) continue;

    const usdc = Number(r.amount_decimal ?? 0);
    const coinBase = Number(r.coin_amount ?? 0);
    const coinTokens = coinBase > 0 ? coinBase / 1e18 : 0;
    const impliedPrice = usdc > 0 && coinTokens > 0 ? usdc / coinTokens : 0;

    if (!Number.isFinite(impliedPrice) || impliedPrice <= 0) continue;

    const key = floorToBucket(ts, bucketMinutes).toISOString();
    const entry = bins.get(key) ?? { prices: [], volumeUsd: 0 };
    entry.prices.push(impliedPrice);
    entry.volumeUsd += usdc;
    bins.set(key, entry);
  }

  const keys = [...bins.keys()].sort();
  if (!keys.length) throw new Error(`unable to derive implied price series for ${addr}`);

  const labels: string[] = [];
  const close: number[] = [];
  const volume: number[] = [];

  for (const k of keys) {
    const b = bins.get(k)!;
    labels.push(new Date(k).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    close.push(Number(b.prices[b.prices.length - 1]!.toFixed(8)));
    volume.push(Number(b.volumeUsd.toFixed(2)));
  }

  const maLen = Math.min(6, Math.max(3, Math.floor(60 / bucketMinutes)));
  const ma: number[] = close.map((_, i) => {
    const start = Math.max(0, i - maLen + 1);
    const window = close.slice(start, i + 1);
    return Number((window.reduce((a, b) => a + b, 0) / window.length).toFixed(8));
  });

  const first = close[0]!;
  const last = close[close.length - 1]!;
  const chg = ((last - first) / Math.max(1e-12, Math.abs(first))) * 100;

  const title = `${coin.symbol || coin.name || addr} • price + volume (${hours}h)`;
  const subtitle = `${coin.address.slice(0, 6)}…${coin.address.slice(-4)} • close $${last.toFixed(8)} • ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% • ${bucketMinutes}m bins`;

  const chart = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "line",
          label: "Price (USD, implied close)",
          data: close,
          yAxisID: "yPrice",
          borderColor: "rgba(37,99,235,0.95)",
          backgroundColor: "rgba(37,99,235,0)",
          fill: false,
          borderWidth: 3,
          pointRadius: 0,
          lineTension: 0.15,
        },
        {
          type: "line",
          label: `MA(${maLen})`,
          data: ma,
          yAxisID: "yPrice",
          borderColor: "rgba(16,185,129,0.95)",
          backgroundColor: "rgba(16,185,129,0)",
          fill: false,
          borderWidth: 2,
          pointRadius: 0,
          lineTension: 0.2,
          borderDash: [6, 4],
        },
        {
          type: "bar",
          label: "Volume (USD/bin)",
          data: volume,
          yAxisID: "yVol",
          backgroundColor: "rgba(148,163,184,0.45)",
          borderColor: "rgba(100,116,139,0.8)",
          borderWidth: 1,
        },
      ],
    },
    options: {
      legend: { position: "bottom" },
      title: { display: true, text: [title, subtitle], fontSize: 16, padding: 12 },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 12 } }],
        yAxes: [
          {
            id: "yPrice",
            position: "left",
            scaleLabel: { display: true, labelString: "Price USD" },
            ticks: { beginAtZero: false },
          },
          {
            id: "yVol",
            position: "right",
            scaleLabel: { display: true, labelString: "Volume USD/bin" },
            ticks: { beginAtZero: true },
            gridLines: { drawOnChartArea: false },
          },
        ],
      },
    },
  };

  const res = await fetch("https://quickchart.io/chart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ width: 1500, height: 900, format: "png", backgroundColor: "white", chart }),
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
    firstPrice: first,
    lastPrice: last,
    changePct: chg,
  };
}
