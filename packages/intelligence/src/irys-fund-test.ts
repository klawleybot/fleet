import { Uploader } from "@irys/upload";
import { BaseEth } from "@irys/upload-ethereum";
import fs from "node:fs";

async function main() {
  let pk = process.env.ZORA_PRIVATE_KEY?.trim()!;
  if (!pk.startsWith("0x")) pk = `0x${pk}`;

  const uploader = await Uploader(BaseEth).withWallet(pk);
  console.log("Address:", uploader.address);
  console.log("Balance before:", (await uploader.getBalance()).toString());

  // Fund Irys with 0.001 ETH
  console.log("Funding 0.001 ETH to Irys...");
  const fundResult = await uploader.fund(1_000_000_000_000_000n);
  console.log("Fund result:", JSON.stringify(fundResult, (_, v) => typeof v === "bigint" ? v.toString() : v));
  console.log("Balance after:", (await uploader.getBalance()).toString());

  // Test upload — grab any existing chart PNG
  const mediaDir = `${process.env.HOME}/.openclaw/media`;
  const pngs = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter(f => f.endsWith(".png")) : [];
  if (pngs.length > 0) {
    const testFile = `${mediaDir}/${pngs[0]}`;
    console.log(`\nTest upload: ${pngs[0]}`);
    const data = fs.readFileSync(testFile);
    const receipt = await uploader.upload(data, {
      tags: [
        { name: "Content-Type", value: "image/png" },
        { name: "App-Name", value: "klawley-intel" },
      ],
    });
    console.log(`✅ Uploaded: https://arweave.net/${receipt.id}`);
  } else {
    console.log("\nNo chart PNGs found to test upload");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
