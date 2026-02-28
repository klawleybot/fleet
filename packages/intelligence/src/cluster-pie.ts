import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

function norm(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

async function buildClusterPie(input: {
  coinAddress: string;
  hours: number;
  topN: number;
  outFile: string;
}) {
  const addr = norm(input.coinAddress);
  const hours = Math.max(1, Math.min(168, Number(input.hours || 24)));
  const topN = Math.max(3, Math.min(12, Number(input.topN || 6)));

  const coin = db.prepare(`SELECT symbol, name, address FROM coins WHERE address = ?`).get(addr) as any;
  if (!coin) throw new Error(`coin not found: ${addr}`);

  const rows = db.prepare(`
    SELECT
      COALESCE(m.cluster_id, 'unclustered') AS bucket,
      SUM(COALESCE(s.amount_decimal, 0)) AS volume_usd,
      COUNT(*) AS swaps
    FROM coin_swaps s
    LEFT JOIN address_cluster_members m ON m.address = s.sender_address
    WHERE s.coin_address = ?
      AND datetime(s.block_timestamp) >= datetime('now', ?)
    GROUP BY bucket
    HAVING volume_usd > 0
    ORDER BY volume_usd DESC
  `).all(addr, `-${hours} hours`) as Array<{ bucket: string; volume_usd: number; swaps: number }>;

  if (!rows.length) throw new Error(`no cluster volume data in last ${hours}h for ${addr}`);

  const total = rows.reduce((a, b) => a + Number(b.volume_usd || 0), 0);
  const top = rows.slice(0, topN);
  const rest = rows.slice(topN);
  const restVol = rest.reduce((a, b) => a + Number(b.volume_usd || 0), 0);

  const labels = top.map((r) => `${r.bucket}`);
  const data = top.map((r) => Number(r.volume_usd.toFixed(2)));

  if (restVol > 0) {
    labels.push("other");
    data.push(Number(restVol.toFixed(2)));
  }

  const palette = [
    "#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316", "#84cc16", "#e11d48", "#14b8a6", "#6366f1", "#64748b", "#a3a3a3",
  ];

  const summary = top
    .map((r) => `${r.bucket}: ${(Number(r.volume_usd || 0) / total * 100).toFixed(1)}%`)
    .slice(0, 4)
    .join(" • ");

  const title = `${coin.symbol || coin.name || shortAddr(addr)} cluster/whale volume share (${hours}h)`;
  const subtitle = `${shortAddr(addr)} • total $${total.toLocaleString(undefined, { maximumFractionDigits: 0 })} • ${summary}`;

  const chart = {
    type: "pie",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: labels.map((_, i) => palette[i % palette.length]),
          borderColor: "#ffffff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      legend: { position: "right" },
      title: { display: true, text: [title, subtitle], fontSize: 16, padding: 12 },
      plugins: {
        datalabels: {
          color: "white",
          formatter: (value: number, ctx: any) => {
            const dataset = ctx?.dataset?.data || [];
            const s = dataset.reduce((a: number, b: number) => a + b, 0);
            const pct = s > 0 ? (value / s) * 100 : 0;
            return `${pct.toFixed(1)}%`;
          },
          font: { weight: "bold", size: 12 },
        },
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
      chart,
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
    coinAddress: addr,
    symbol: coin.symbol ?? null,
    name: coin.name ?? null,
    buckets: labels.length,
    totalVolumeUsd: total,
  };
}

async function main() {
  const coinAddress = process.argv[2];
  if (!coinAddress) throw new Error("Usage: tsx src/cluster-pie.ts <coin_address> [hours=24] [topN=6] [outFile]");

  const hours = Number(process.argv[3] ?? 24);
  const topN = Number(process.argv[4] ?? 6);
  const defaultOutDir = fs.existsSync('/Users/user/.openclaw/media') ? '/Users/user/.openclaw/media' : './tmp';
  const outFile = process.argv[5] ?? `${defaultOutDir}/cluster-pie-${norm(coinAddress)}.png`;

  const result = await buildClusterPie({ coinAddress, hours, topN, outFile });
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
