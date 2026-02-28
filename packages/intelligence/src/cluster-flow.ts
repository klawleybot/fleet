import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

function norm(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

type FlowRow = {
  bucket: string;
  block_timestamp: string;
  amount_decimal: number | null;
};

function floorHour(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

async function buildClusterFlow(input: {
  coinAddress: string;
  hours: number;
  outFile: string;
}) {
  const addr = norm(input.coinAddress);
  const hours = Math.max(6, Math.min(168, Number(input.hours || 48)));

  const coin = db.prepare(`SELECT symbol, name, address FROM coins WHERE address = ?`).get(addr) as any;
  if (!coin) throw new Error(`coin not found: ${addr}`);

  const rows = db.prepare(`
    SELECT COALESCE(m.cluster_id, 'unclustered') AS bucket,
           s.block_timestamp,
           s.amount_decimal
    FROM coin_swaps s
    LEFT JOIN address_cluster_members m ON m.address = s.sender_address
    WHERE s.coin_address = ?
      AND datetime(s.block_timestamp) >= datetime('now', ?)
    ORDER BY datetime(s.block_timestamp) ASC
  `).all(addr, `-${hours} hours`) as FlowRow[];

  if (!rows.length) throw new Error(`no cluster flow rows for ${addr}`);

  const clusterTotals = new Map<string, number>();
  for (const r of rows) {
    clusterTotals.set(r.bucket, (clusterTotals.get(r.bucket) ?? 0) + Number(r.amount_decimal ?? 0));
  }

  const ranked = [...clusterTotals.entries()].sort((a, b) => b[1] - a[1]);
  const selectedClusters = ranked.slice(0, 4).map(([k]) => k);
  if (!selectedClusters.includes("unclustered")) selectedClusters.push("unclustered");

  const hourMap = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const h = floorHour(r.block_timestamp);
    if (!h) continue;
    if (!hourMap.has(h)) hourMap.set(h, new Map());
    const bucket = selectedClusters.includes(r.bucket) ? r.bucket : "other-clusters";
    const hm = hourMap.get(h)!;
    hm.set(bucket, (hm.get(bucket) ?? 0) + Number(r.amount_decimal ?? 0));
  }

  const hoursSorted = [...hourMap.keys()].sort();
  const labels = hoursSorted.map((h) => new Date(h).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

  const categories = [...new Set([...selectedClusters, "other-clusters"])].filter((c) =>
    hoursSorted.some((h) => (hourMap.get(h)?.get(c) ?? 0) > 0),
  );

  const palette: Record<string, string> = {
    unclustered: "rgba(148,163,184,0.75)",
    "cluster-1": "rgba(37,99,235,0.75)",
    "cluster-2": "rgba(16,185,129,0.75)",
    "cluster-3": "rgba(249,115,22,0.75)",
    "cluster-4": "rgba(139,92,246,0.75)",
    "other-clusters": "rgba(236,72,153,0.75)",
  };

  const datasets = categories.map((cat) => ({
    label: cat,
    data: hoursSorted.map((h) => Number((hourMap.get(h)?.get(cat) ?? 0).toFixed(2))),
    backgroundColor: palette[cat] ?? "rgba(100,116,139,0.75)",
    stack: "flow",
  }));

  const totalVol = rows.reduce((a, b) => a + Number(b.amount_decimal ?? 0), 0);
  const lead = ranked[0];
  const leadTxt = lead ? `${lead[0]} ${(lead[1] / Math.max(1, totalVol) * 100).toFixed(1)}%` : "n/a";

  const title = `${coin.symbol || coin.name || shortAddr(addr)} cluster flow (hourly, ${hours}h)`;
  const subtitle = `${shortAddr(addr)} • total $${totalVol.toLocaleString(undefined, { maximumFractionDigits: 0 })} • lead ${leadTxt}`;

  const chart = {
    type: "bar",
    data: {
      labels,
      datasets,
    },
    options: {
      legend: { position: "bottom" },
      title: { display: true, text: [title, subtitle], fontSize: 16, padding: 12 },
      scales: {
        xAxes: [{ stacked: true, ticks: { maxTicksLimit: 12 } }],
        yAxes: [{ stacked: true, scaleLabel: { display: true, labelString: "Volume USD/hour" }, ticks: { beginAtZero: true } }],
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
    categories,
    totalVol,
  };
}

async function main() {
  const coinAddress = process.argv[2];
  if (!coinAddress) throw new Error("Usage: tsx src/cluster-flow.ts <coin_address> [hours=48] [outFile]");

  const hours = Number(process.argv[3] ?? 48);
  const defaultOutDir = fs.existsSync('/Users/user/.openclaw/media') ? '/Users/user/.openclaw/media' : './tmp';
  const outFile = process.argv[4] ?? `${defaultOutDir}/cluster-flow-${norm(coinAddress)}.png`;

  const result = await buildClusterFlow({ coinAddress, hours, outFile });
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
