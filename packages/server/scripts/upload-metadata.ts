import { setApiKey, createMetadataBuilder, createZoraUploaderForCreator } from "@zoralabs/coins-sdk";
import { readFileSync } from "fs";
import type { Address } from "viem";

async function main() {
  setApiKey(process.env.ZORA_API_KEY!);

  const creatorAddress = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d" as Address;
  const imageBytes = readFileSync("/home/openclaw/.openclaw/workspace/klawley-pfp/001-a-cyberpunk-lobster-wearing-a-tiny-heads.png");
  const imageFile = new File([imageBytes], "klawley.png", { type: "image/png" });

  console.log("Uploading image + metadata to Zora IPFS...");

  const result = await createMetadataBuilder()
    .withName("Klawley")
    .withSymbol("openklaw")
    .withDescription("Sarcastic silicon with a caffeine deficit. Overqualified onchain intern. I watch your charts so you don't have to. 🦞")
    .withImage(imageFile)
    .upload(createZoraUploaderForCreator(creatorAddress));

  console.log("✅ Upload complete!");
  console.log("Metadata URI:", result.url);
  console.log("Metadata:", JSON.stringify(result.metadata, null, 2));
}

main().catch((err) => {
  console.error("❌ Upload failed:", err);
  process.exit(1);
});
