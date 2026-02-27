import { db } from "../src/db/index.js";
import { approveAndExecuteOperation } from "../src/services/operations.js";

const opIds = process.argv.slice(2).map(Number).filter(n => n > 0);
if (!opIds.length) { console.log("Usage: approve-ops.ts <id> [id...]"); process.exit(1); }

for (const id of opIds) {
  const op = db.getOperationById(id);
  if (!op) { console.log(`Op ${id}: not found`); continue; }
  const p = JSON.parse(op.payloadJson);
  console.log(`Op ${id}: ${op.type} | status=${op.status} | cluster=${op.clusterId} | coin=${p.coinAddress?.slice(0,10)}`);
  
  if (op.status !== "pending" && op.status !== "approved") {
    console.log(`  → skipped (status=${op.status})`);
    continue;
  }

  try {
    const result = await approveAndExecuteOperation({ operationId: id, approvedBy: "flick-manual" });
    console.log(`  → ${result.status}`);
    if (result.resultJson) {
      const r = JSON.parse(result.resultJson);
      const ok = r.trades?.filter((t: any) => t.status === "complete").length ?? 0;
      const fail = r.trades?.filter((t: any) => t.status === "failed").length ?? 0;
      console.log(`  → ${ok} ok, ${fail} failed out of ${r.tradeCount} trades`);
    }
    if (result.errorMessage) console.log(`  → error: ${result.errorMessage}`);
  } catch (e: any) {
    console.log(`  → execution error: ${e.message}`);
  }
}
