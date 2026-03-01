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
  
  const tags = [
    { name: "Content-Type", value: mime },
    { name: "App-Name", value: "klawley-intel" },
  ];

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
  
  const tags = [
    { name: "Content-Type", value: contentType },
    { name: "App-Name", value: "klawley-intel" },
    ...(filename ? [{ name: "Filename", value: filename }] : []),
  ];

  const receipt = await uploader.upload(buffer, { tags });
  return `https://gateway.irys.xyz/${receipt.id}`;
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
