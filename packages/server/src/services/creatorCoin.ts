/**
 * Creator Coin deployment via Zora SDK's create/content API.
 *
 * Uses the SDK's server-side calldata generation (postCreateContent)
 * which handles pool config, currency routing, and factory encoding.
 *
 * The creator coin is backed by $ZORA and is the identity coin for an address.
 * Only the FIRST creator coin per address is recognized by Zora's indexer.
 */

import {
  type Address,
  type Chain,
  type Hex,
  type Log,
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { zoraFactoryAbi, ZORA_FACTORY_ADDRESSES, parseCoinCreatedLogs } from "./coinLauncher.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatorCoinMetadata {
  name: string;
  symbol: string;
  description: string;
  /** IPFS URI or HTTPS URL for the coin image */
  imageURI: string;
}

export interface CreatorCoinDeployParams {
  /** The address that will be the creator (smart wallet address) */
  creator: Address;
  metadata: CreatorCoinMetadata;
  /** Chain ID — defaults to Base mainnet (8453) */
  chainId?: number;
  /** Platform referrer for attribution */
  platformReferrer?: Address;
  /** Additional owner addresses */
  additionalOwners?: Address[];
  /** Override payout recipient (defaults to creator) */
  payoutRecipient?: Address;
}

export interface CreatorCoinDeployResult {
  coinAddress: Address;
  predictedAddress: Address;
  txHash: Hex;
  poolAddress?: Address;
}

// ---------------------------------------------------------------------------
// Zora SDK API client (lightweight, no SDK import needed)
// ---------------------------------------------------------------------------

const ZORA_API_BASE = "https://api-sdk.zora.engineering";

interface ZoraCreateContentResponse {
  calls: Array<{
    to: string;
    value: string;
    data: string;
  }>;
  predictedCoinAddress: string;
  usedSmartWalletRouting: boolean;
}

/**
 * Call the Zora SDK's /create/content endpoint to get deployment calldata.
 * This handles pool config generation server-side.
 */
async function getCreatorCoinCalldata(params: {
  creator: string;
  name: string;
  symbol: string;
  metadataURI: string;
  chainId: number;
  platformReferrer?: string;
  additionalOwners?: string[];
  payoutRecipientOverride?: string;
}): Promise<ZoraCreateContentResponse> {
  const body: Record<string, unknown> = {
    currency: "ZORA", // Creator coins are always backed by $ZORA
    chainId: params.chainId,
    metadata: {
      type: "RAW_URI",
      uri: params.metadataURI,
    },
    creator: params.creator,
    name: params.name,
    symbol: params.symbol,
  };

  if (params.platformReferrer) {
    body.platformReferrer = params.platformReferrer;
  }
  if (params.additionalOwners?.length) {
    body.additionalOwners = params.additionalOwners;
  }
  if (params.payoutRecipientOverride) {
    body.payoutRecipientOverride = params.payoutRecipientOverride;
  }

  const res = await fetch(`${ZORA_API_BASE}/create/content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zora create/content API error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as ZoraCreateContentResponse;

  if (!data.calls?.length) {
    throw new Error("Zora API returned no deployment calls");
  }

  return data;
}

// ---------------------------------------------------------------------------
// Metadata upload to Zora's IPFS (via their JWT-authenticated endpoint)
// ---------------------------------------------------------------------------

/**
 * Upload metadata JSON + image to Zora's IPFS infrastructure.
 * Returns the IPFS URI for the metadata JSON.
 *
 * Note: This requires the image to already be hosted at a URL.
 * For local files, upload the image first, then pass the URL.
 */
async function uploadToZoraIPFS(
  file: { content: Buffer | Uint8Array; filename: string; mimeType: string },
  creatorAddress: Address,
  apiKey?: string,
): Promise<string> {
  // Get JWT from Zora API
  const jwtRes = await fetch(`${ZORA_API_BASE}/createUploadJWT`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "api-key": apiKey } : {}),
    },
    body: JSON.stringify({ creatorAddress }),
  });

  if (!jwtRes.ok) {
    throw new Error(`Failed to get upload JWT: ${jwtRes.status} ${await jwtRes.text()}`);
  }

  const jwtData = (await jwtRes.json()) as { createUploadJwtFromApiKey?: string };
  const jwt = jwtData.createUploadJwtFromApiKey;
  if (!jwt) {
    throw new Error("No JWT returned from Zora API — may require an API key");
  }

  // Upload file to Zora IPFS
  const formData = new FormData();
  const blob = new Blob([file.content], { type: file.mimeType });
  formData.append("file", blob, file.filename);

  const uploadRes = await fetch("https://ipfs-uploader.zora.co/api/v0/add?cid-version=1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "*/*",
    },
    body: formData,
  });

  if (!uploadRes.ok) {
    throw new Error(`IPFS upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  const uploadData = (await uploadRes.json()) as { cid: string };
  return `ipfs://${uploadData.cid}`;
}

/**
 * Build and upload coin metadata (image + JSON) to Zora's IPFS.
 * Returns the metadata URI to pass to the deploy function.
 */
export async function uploadCreatorCoinMetadata(
  metadata: CreatorCoinMetadata,
  creatorAddress: Address,
  imageBuffer?: Buffer | Uint8Array,
  apiKey?: string,
): Promise<string> {
  let imageURI = metadata.imageURI;

  // If we have a local image buffer, upload it first
  if (imageBuffer) {
    const ext = metadata.imageURI.split(".").pop() || "png";
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    imageURI = await uploadToZoraIPFS(
      { content: imageBuffer, filename: `creator-coin.${ext}`, mimeType },
      creatorAddress,
      apiKey,
    );
    logger.info({ imageURI }, "Uploaded creator coin image to IPFS");
  }

  // Build metadata JSON
  const metadataJSON = {
    name: metadata.name,
    symbol: metadata.symbol,
    description: metadata.description,
    image: imageURI,
  };

  // Upload metadata JSON
  const metadataContent = Buffer.from(JSON.stringify(metadataJSON));
  const metadataURI = await uploadToZoraIPFS(
    { content: metadataContent, filename: "metadata.json", mimeType: "application/json" },
    creatorAddress,
    apiKey,
  );

  logger.info({ metadataURI }, "Uploaded creator coin metadata to IPFS");
  return metadataURI;
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

/**
 * Deploy a Creator Coin on Zora.
 *
 * Flow:
 * 1. Call Zora's /create/content API to get deployment calldata
 * 2. Send the transaction from the EOA (which controls the smart wallet)
 * 3. Parse the CoinCreated event from the receipt
 *
 * The transaction is sent directly from the EOA signer, not through the
 * smart wallet's UserOp flow, because the Zora API may route through
 * smart wallet infrastructure internally.
 */
export async function deployCreatorCoin(
  params: CreatorCoinDeployParams,
  privateKey: Hex,
): Promise<CreatorCoinDeployResult> {
  const chainId = params.chainId ?? 8453;
  const chain = chainId === 8453 ? base : base; // TODO: add sepolia support

  // Get calldata from Zora API
  const metadataURI = `ipfs://placeholder`; // Will be replaced with real URI
  logger.info({
    creator: params.creator,
    name: params.metadata.name,
    symbol: params.metadata.symbol,
  }, "Fetching creator coin deployment calldata from Zora API");

  const createResponse = await getCreatorCoinCalldata({
    creator: params.creator,
    name: params.metadata.name,
    symbol: params.metadata.symbol,
    metadataURI: params.metadata.imageURI, // Use the image URI as metadata for now
    chainId,
    platformReferrer: params.platformReferrer,
    additionalOwners: params.additionalOwners,
    payoutRecipientOverride: params.payoutRecipient,
  });

  const call = createResponse.calls[0]!;
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({
    chain,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  logger.info({
    to: call.to,
    value: call.value,
    predictedAddress: createResponse.predictedCoinAddress,
    usedSmartWalletRouting: createResponse.usedSmartWalletRouting,
  }, "Sending creator coin deployment transaction");

  // Send the transaction
  const txHash = await walletClient.sendTransaction({
    to: call.to as Address,
    data: call.data as Hex,
    value: BigInt(call.value),
    chain,
  });

  logger.info({ txHash }, "Creator coin deployment tx sent, waiting for receipt");

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== "success") {
    throw new Error(`Creator coin deployment tx reverted: ${txHash}`);
  }

  // Parse the coin address from events
  const { coinAddress, poolAddress } = parseCoinCreatedLogs(receipt.logs);

  logger.info({
    coinAddress,
    poolAddress,
    txHash,
    predicted: createResponse.predictedCoinAddress,
  }, "Creator coin deployed successfully");

  return {
    coinAddress,
    predictedAddress: createResponse.predictedCoinAddress as Address,
    txHash,
    poolAddress,
  };
}

// ---------------------------------------------------------------------------
// Full deploy flow (upload metadata + deploy)
// ---------------------------------------------------------------------------

/**
 * Complete creator coin deployment: upload metadata to IPFS, then deploy.
 *
 * @param params - Deployment parameters
 * @param privateKey - Private key of the EOA signer
 * @param imageBuffer - Optional local image buffer to upload
 * @param apiKey - Optional Zora API key for IPFS uploads
 */
export async function deployCreatorCoinWithMetadata(
  params: CreatorCoinDeployParams,
  privateKey: Hex,
  imageBuffer?: Buffer | Uint8Array,
  apiKey?: string,
): Promise<CreatorCoinDeployResult> {
  // Upload metadata first if we have a local image
  let metadataURI: string;
  if (imageBuffer) {
    metadataURI = await uploadCreatorCoinMetadata(
      params.metadata,
      params.creator,
      imageBuffer,
      apiKey,
    );
  } else {
    // Image is already hosted — just build and upload metadata JSON
    metadataURI = await uploadCreatorCoinMetadata(
      params.metadata,
      params.creator,
      undefined,
      apiKey,
    );
  }

  // Now deploy with the uploaded metadata URI
  const deployParams: CreatorCoinDeployParams = {
    ...params,
    metadata: {
      ...params.metadata,
      imageURI: metadataURI, // Override with IPFS metadata URI
    },
  };

  return deployCreatorCoin(deployParams, privateKey);
}
