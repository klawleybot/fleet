/**
 * Post a cast to Farcaster via Neynar's snapchain API.
 *
 * Usage:
 *   NEYNAR_API_KEY=... FARCASTER_FID=... FARCASTER_SIGNER_PRIVATE_KEY=...
 *   npx tsx post-farcaster.ts --text "hello" [--image /path/to/img.png] [--embed https://...]
 *
 * Requires @farcaster/hub-nodejs installed.
 */

import {
  makeCastAdd,
  NobleEd25519Signer,
  FarcasterNetwork,
  Message,
} from "@farcaster/hub-nodejs";
import { readFileSync } from "fs";
import { resolve } from "path";

interface PostOptions {
  text: string;
  embeds?: string[];
  imagePath?: string;
}

async function uploadImageToImgur(imagePath: string): Promise<string | null> {
  // Farcaster doesn't support local images — need a URL.
  // Try Zora IPFS upload if API key available, otherwise skip.
  const apiKey = process.env.ZORA_API_KEY;
  if (!apiKey) return null;

  try {
    const { setApiKey, createZoraUploaderForCreator } = await import("@zoralabs/coins-sdk");
    setApiKey(apiKey);

    const imageBytes = readFileSync(imagePath);
    const ext = imagePath.split(".").pop() || "png";
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

    // Use Zora's upload endpoint to get an IPFS URL
    const uploader = createZoraUploaderForCreator("0x097677d3e2cde65af10be80ae5e67b8b68eb613d");
    const result = await uploader(new File([imageBytes], `cast-image.${ext}`, { type: mimeType }));
    console.log("📤 Image uploaded to IPFS:", result);
    return result;
  } catch (err) {
    console.error("⚠️ Image upload failed:", err);
    return null;
  }
}

export async function postCast(opts: PostOptions): Promise<{ hash: string; success: boolean }> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const fid = parseInt(process.env.FARCASTER_FID || "0");
  const signerKey = process.env.FARCASTER_SIGNER_PRIVATE_KEY;

  if (!apiKey || !fid || !signerKey) {
    throw new Error("Missing NEYNAR_API_KEY, FARCASTER_FID, or FARCASTER_SIGNER_PRIVATE_KEY");
  }

  const embeds: Array<{ url: string }> = [];

  // Upload image if provided
  if (opts.imagePath) {
    const imageUrl = await uploadImageToImgur(opts.imagePath);
    if (imageUrl) {
      // Convert ipfs:// to gateway URL for Farcaster
      const gatewayUrl = imageUrl.startsWith("ipfs://")
        ? `https://ipfs.decentralized-content.com/ipfs/${imageUrl.slice(7)}`
        : imageUrl;
      embeds.push({ url: gatewayUrl });
    }
  }

  // Add any explicit embeds
  if (opts.embeds) {
    for (const url of opts.embeds) {
      embeds.push({ url });
    }
  }

  const signerBytes = Buffer.from(signerKey, "hex");
  const signer = new NobleEd25519Signer(signerBytes);

  const castResult = await makeCastAdd(
    {
      text: opts.text,
      embeds,
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
    },
    { fid, network: FarcasterNetwork.MAINNET },
    signer
  );

  if (castResult.isErr()) {
    throw new Error(`Failed to create cast: ${castResult.error}`);
  }

  const cast = castResult.value;
  const hash = "0x" + Buffer.from(cast.hash).toString("hex");
  const messageBytes = Buffer.from(Message.encode(cast).finish());

  console.log("📡 Submitting cast to Farcaster...");
  console.log("   Hash:", hash);
  console.log("   Text:", opts.text.slice(0, 80) + (opts.text.length > 80 ? "..." : ""));
  console.log("   Embeds:", embeds.length);

  const resp = await fetch("https://snapchain-api.neynar.com/v1/submitMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-api-key": apiKey,
    },
    body: messageBytes,
  });

  const success = resp.status === 200;
  if (!success) {
    const body = await resp.text();
    console.error("❌ Cast submission failed:", resp.status, body.slice(0, 200));
  } else {
    console.log("✅ Cast published!");
    console.log("   View: https://warpcast.com/klawley/" + hash.slice(0, 10));
  }

  return { hash, success };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let text = "";
  let imagePath: string | undefined;
  const embeds: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--text" && args[i + 1]) text = args[++i];
    else if (args[i] === "--image" && args[i + 1]) imagePath = resolve(args[++i]);
    else if (args[i] === "--embed" && args[i + 1]) embeds.push(args[++i]);
  }

  if (!text) {
    console.error("Usage: post-farcaster.ts --text 'your cast' [--image path] [--embed url]");
    process.exit(1);
  }

  postCast({ text, imagePath, embeds })
    .then(({ hash, success }) => {
      console.log(JSON.stringify({ hash, success }));
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("❌", err.message);
      process.exit(1);
    });
}
