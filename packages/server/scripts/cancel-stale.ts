import { db } from "../src/db/index.js";

for (const id of [62, 63]) {
  const op = db.getOperationById(id);
  if (!op) { console.log(`Op ${id}: not found`); continue; }
  console.log(`Op ${id}: ${op.type} status=${op.status}`);
  if (op.status === "pending" || op.status === "executing") {
    db.updateOperationStatus(id, "failed", "Cancelled — stale pending order");
    console.log(`  → marked failed`);
  } else {
    console.log(`  → skipped (${op.status})`);
  }
}
