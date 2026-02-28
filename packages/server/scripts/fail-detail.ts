import { db } from "../src/db/index.js";

const ops = db.listOperations(10);
for (const op of ops.reverse()) {
  const r = op.resultJson ? JSON.parse(op.resultJson) : null;
  const trades = r?.trades || r?.results || [];
  const failed = trades.filter((t: any) => t.status === "failed");
  if (failed.length === 0) continue;
  
  const p = JSON.parse(op.payloadJson);
  console.log(`\n=== Op #${op.id} | ${op.type} | ${op.createdAt} ===`);
  console.log(`coin: ${p.coinAddress?.slice(0, 12)} | cluster: ${op.clusterId}`);
  console.log(`${trades.length - failed.length} ok / ${failed.length} failed\n`);
  
  // Group errors by message
  const errorGroups: Record<string, number> = {};
  for (const t of failed) {
    const err = (t.error || t.errorMessage || "unknown").slice(0, 200);
    errorGroups[err] = (errorGroups[err] || 0) + 1;
  }
  for (const [err, count] of Object.entries(errorGroups)) {
    console.log(`  [${count}x] ${err}`);
  }
}
