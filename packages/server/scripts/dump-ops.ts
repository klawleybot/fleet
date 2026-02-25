import { db } from "../src/db/index.js";
import { formatEther } from "viem";

const ops = db.listOperations(50);
console.log("id | type | status | coin | amount | cluster | by | error");
console.log("---|------|--------|------|--------|---------|----|---------");
for (const op of ops) {
  const meta = op.metadata ? JSON.parse(op.metadata as string) : {};
  const amt = meta.totalAmountWei ? formatEther(BigInt(meta.totalAmountWei)) : "-";
  const coin = meta.coinAddress ? `${meta.coinAddress.slice(0, 6)}…${meta.coinAddress.slice(-4)}` : "-";
  console.log(
    `${op.id} | ${op.type} | ${op.status} | ${coin} | ${amt} ETH | c${op.clusterId} | ${op.requestedBy || "-"} | ${op.errorMessage?.slice(0, 60) || "ok"}`
  );
}
