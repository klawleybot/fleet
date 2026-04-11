/**
 * Arweave image upload via Irys (Base ETH).
 * Uploads local files to Arweave, returns permanent gateway URL.
 */

import fs from "node:fs";
import path from "node:path";
import { Uploader } from "@irys/upload";
import { BaseEth } from "@irys/upload-ethereum";

let uploaderInstance: Awaited<ReturnType<typeof buildUploader>> | null = null;

async function buildUploader() {
  let privateKey = process.env.ZORA_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("ZORA_PRIVATE_KEY not set — needed for Irys uploads");
  }
  // Ensure 0x prefix
  if (!privateKey.startsWith("0x")) privateKey = `0x${privateKey}`;
  return Uploader(BaseEth).withWallet(privateKey);
}

async function getUploader() {
  if (!uploaderInstance) {
    uploaderInstance = await buildUploader();
  }
  return uploaderInstance;
}

/**
 * Upload a local file to Arweave via Irys.
 * Returns the permanent Arweave gateway URL.
 */
export async function uploadToArweave(filePath: string, contentType?: string): Promise<string> {
  const uploader = await getUploader();
  
  const data = fs.readFileSync(filePath);
  const mime = contentType ?? guessMimeType(filePath);
  const filename = path.basename(filePath);
  
  const tags = buildTags(mime, data.length, filename);

  const receipt = await uploader.upload(data, { tags });
  const txId = receipt.id;
  
  return `https://gateway.irys.xyz/${txId}`;
}

/**
 * Upload raw buffer to Arweave via Irys.
 */
export async function uploadBufferToArweave(
  buffer: Buffer,
  contentType: string,
  filename?: string,
): Promise<string> {
  const uploader = await getUploader();
  
  const tags = buildTags(contentType, buffer.length, filename);

  const receipt = await uploader.upload(buffer, { tags });
  return `https://gateway.irys.xyz/${receipt.id}`;
}

/**
 * Upload a string (e.g. JSON metadata) to Arweave via Irys.
 */
export async function uploadDataToArweave(
  data: string,
  contentType: string = "application/json",
  filename?: string,
): Promise<string> {
  return uploadBufferToArweave(Buffer.from(data, "utf-8"), contentType, filename ?? "metadata.json");
}

/**
 * Check Irys balance for the configured wallet.
 */
export async function getIrysBalance(): Promise<{ address: string; balance: string }> {
  const uploader = await getUploader();
  const balance = await uploader.getBalance();
  return {
    address: uploader.address ?? "unknown",
    balance: balance.toString(),
  };
}

/**
 * Build standard Irys/Arweave tags for uploads.
 * These map to HTTP headers on gateway responses.
 */
function buildTags(
  contentType: string,
  contentLength: number,
  filename?: string,
): Array<{ name: string; value: string }> {
  const tags: Array<{ name: string; value: string }> = [
    { name: "Content-Type", value: contentType },
    { name: "Content-Length", value: String(contentLength) },
    { name: "App-Name", value: "klawley-intel" },
    // Immutable content — cache forever
    { name: "Cache-Control", value: "public, max-age=31536000, immutable" },
    { name: "Upload-Timestamp", value: new Date().toISOString() },
  ];

  if (filename) {
    // inline for images so browsers render them; attachment for other types
    const isInline = contentType.startsWith("image/") || contentType === "application/json";
    const disposition = isInline
      ? `inline; filename="${filename}"`
      : `attachment; filename="${filename}"`;
    tags.push({ name: "Content-Disposition", value: disposition });
    tags.push({ name: "Filename", value: filename });
  }

  return tags;
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json";
    default: return "application/octet-stream";
  }
}
