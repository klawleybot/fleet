import { buildPriceVolumeChart, defaultMediaOut } from "./price-volume-lib.js";

function norm(v: string) {
  return String(v ?? "").trim().toLowerCase();
}

async function main() {
  const coinAddress = process.argv[2];
  if (!coinAddress) throw new Error("Usage: tsx src/price-volume.ts <coin_address> [hours=24] [bucketMinutes=15] [outFile]");

  const hours = Number(process.argv[3] ?? 24);
  const bucketMinutes = Number(process.argv[4] ?? 15);
  const outFile = process.argv[5] ?? defaultMediaOut(`price-volume-${norm(coinAddress)}.png`);

  const result = await buildPriceVolumeChart({ coinAddress, hours, bucketMinutes, outFile });
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
