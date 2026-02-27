import { db } from "../src/db/index.js";

const opIds = process.argv.slice(2).map(Number).filter(n => n > 0);
if (!opIds.length) { console.log("Usage: cancel-ops.ts <id> [id...]"); process.exit(1); }

for (const id of opIds) {
  const op = db.getOperationById(id);
  if (!op) { console.log(`Op ${id}: not found`); continue; }
  if (op.status !== "pending") { console.log(`Op ${id}: already ${op.status}, skipping`); continue; }
  db.updateOperationStatus(id, "cancelled", "Manually cancelled — stale");
  console.log(`Op ${id}: cancelled`);
}
