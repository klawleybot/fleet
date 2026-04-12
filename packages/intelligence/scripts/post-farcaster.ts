/**
 * Post a cast to Farcaster via Neynar's snapchain API.
 *
 * Usage:
 *   NEYNAR_API_KEY=... FARCASTER_FID=... FARCASTER_SIGNER_PRIVATE_KEY=...
 *   bun x tsx scripts/post-farcaster.ts --text "hello" [--image /path/to/img.png] [--embed https://...]
 *
 * Requires @farcaster/hub-nodejs installed.
 */

import {
  makeCastAdd,
  NobleEd25519Signer,
  FarcasterNetwork,
  Message,
} from "@farcaster/hub-nodejs";
import { resolve } from "path";

interface PostOptions {
  text: string;
  embeds?: string[];
  imagePath?: string;
}

async function uploadImage(imagePath: string): Promise<string | null> {
  // Priority: Arweave (permanent, funded) → fail
  // Zora uploader not used here (Farcaster, not Zora content)
  // No free IPFS fallback — content won't stick
  try {
    const { uploadToArweave } = await import("../src/arweave.js");
    const url = await uploadToArweave(imagePath);
    if (url) {
      console.log("📤 Image uploaded to Arweave:", url);
      return url;
    }
  } catch (err) {
    console.error("⚠️ Arweave upload failed:", (err as Error).message);
  }

  console.error("⚠️ No upload method available — cast will be text-only");
  return null;
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
    const imageUrl = await uploadImage(opts.imagePath);
    if (imageUrl) {
      embeds.push({ url: imageUrl });
    } else {
      console.warn("⚠️ Image upload failed — cast will be text-only");
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

  // Use LONG_CAST (type 1) if text > 320 bytes, otherwise regular CAST (type 0)
  const textBytes = new TextEncoder().encode(opts.text);
  const castType = textBytes.length > 320 ? 1 : 0; // 0 = CAST, 1 = LONG_CAST

  const castResult = await makeCastAdd(
    {
      type: castType,
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
