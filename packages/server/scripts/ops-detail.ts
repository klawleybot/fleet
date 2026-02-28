import { db } from "../src/db/index.js";

const ops = db.listOperations(20);
for (const op of ops.reverse()) {
  const p = JSON.parse(op.payloadJson);
  const r = op.resultJson ? JSON.parse(op.resultJson) : null;
  const trades = r?.trades || r?.results || [];
  const ok = trades.filter((t: any) => t.status === "complete").length;
  const fail = trades.filter((t: any) => t.status === "failed").length;
  const errSample = trades.find((t: any) => t.status === "failed")?.error?.slice(0, 80) || "";
  console.log(`#${op.id} | ${op.type} | ${op.status} | c${op.clusterId} | by:${op.requestedBy} | coin:${p.coinAddress?.slice(0,10) || "signal"} | amt:${p.totalAmountWei ? (Number(p.totalAmountWei)/1e18).toFixed(6) : "-"} ETH | ${ok}ok/${fail}fail | ${op.createdAt}${errSample ? " | err:" + errSample : ""}`);
}
