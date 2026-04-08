/**
 * Creator Coin deployment via Zora's create/content API + Pimlico bundler.
 *
 * Routes the deployment through the smart wallet as a UserOp so gas
 * is sponsored by Pimlico's paymaster — no ETH needed in any wallet.
 *
 * Creator coins are backed by $ZORA. Only the FIRST creator coin per
 * address is recognized by Zora's indexer as the "official" one.
 */

import {
  type Address,
  type Hex,
  type Log,
  createPublicClient,
  http,
  isAddress,
  isHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { parseCoinCreatedLogs } from "./coinLauncher.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatorCoinMetadata {
  name: string;
  symbol: string;
  description: string;
  /** Metadata URI (ipfs:// or https://) pointing to a JSON file */
  metadataURI: string;
}

export interface CreatorCoinDeployParams {
  /** The smart wallet address that will be the creator */
  creator: Address;
  metadata: CreatorCoinMetadata;
  chainId?: number;
  platformReferrer?: Address;
  additionalOwners?: Address[];
  payoutRecipient?: Address;
}

export interface CreatorCoinDeployResult {
  coinAddress: Address;
  predictedAddress: Address;
  txHash: Hex;
}

// ---------------------------------------------------------------------------
// Zora API
// ---------------------------------------------------------------------------

const ZORA_API = "https://api-sdk.zora.engineering";

interface ZoraCreateCall {
  to: Address;
  value: string;
  data: Hex;
}

interface ZoraCreateResponse {
  calls: ZoraCreateCall[];
  predictedCoinAddress: Address;
  usedSmartWalletRouting: boolean;
}

function parseZoraCreateCall(value: unknown, index: number): ZoraCreateCall {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Zora API returned invalid call at index ${index}`);
  }

  const { to, value: callValue, data } = value as {
    to?: unknown;
    value?: unknown;
    data?: unknown;
  };

  if (typeof to !== "string" || !isAddress(to)) {
    throw new Error(`Zora API returned invalid call target at index ${index}`);
  }
  if (typeof callValue !== "string") {
    throw new Error(`Zora API returned invalid call value at index ${index}`);
  }
  if (typeof data !== "string" || !isHex(data)) {
    throw new Error(`Zora API returned invalid call data at index ${index}`);
  }

  return { to, value: callValue, data };
}

function parseZoraCreateResponse(json: unknown): ZoraCreateResponse {
  if (typeof json !== "object" || json === null) {
    throw new Error("Zora API returned a non-object response");
  }

  const {
    calls,
    predictedCoinAddress,
    usedSmartWalletRouting,
  } = json as {
    calls?: unknown;
    predictedCoinAddress?: unknown;
    usedSmartWalletRouting?: unknown;
  };

  if (!Array.isArray(calls)) {
    throw new Error("Zora API returned calls in an invalid format");
  }
  if (typeof predictedCoinAddress !== "string" || !isAddress(predictedCoinAddress)) {
    throw new Error("Zora API returned an invalid predicted coin address");
  }
  if (typeof usedSmartWalletRouting !== "boolean") {
    throw new Error("Zora API returned an invalid smart wallet routing flag");
  }

  return {
    calls: calls.map((call, index) => parseZoraCreateCall(call, index)),
    predictedCoinAddress,
    usedSmartWalletRouting,
  };
}

export async function getCreatorCoinCalldata(params: {
  creator: string;
  name: string;
  symbol: string;
  metadataURI: string;
  chainId: number;
  platformReferrer?: string;
  additionalOwners?: string[];
  payoutRecipientOverride?: string;
}): Promise<ZoraCreateResponse> {
  const body: Record<string, unknown> = {
    currency: "ZORA",
    chainId: params.chainId,
    metadata: { type: "RAW_URI", uri: params.metadataURI },
    creator: params.creator,
    name: params.name,
    symbol: params.symbol,
  };
  if (params.platformReferrer) body.platformReferrer = params.platformReferrer;
  if (params.additionalOwners?.length) body.additionalOwners = params.additionalOwners;
  if (params.payoutRecipientOverride) body.payoutRecipientOverride = params.payoutRecipientOverride;

  const res = await fetch(`${ZORA_API}/create/content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Zora API error (${res.status}): ${await res.text()}`);
  }

  const data = parseZoraCreateResponse(await res.json());
  if (data.calls.length === 0) throw new Error("Zora API returned no deployment calls");
  return data;
}

// ---------------------------------------------------------------------------
// Deploy via Pimlico-sponsored UserOp
// ---------------------------------------------------------------------------

/**
 * Deploy a Creator Coin using the smart wallet + Pimlico gas sponsorship.
 *
 * The EOA (ZORA_PRIVATE_KEY) signs as the smart wallet owner.
 * Pimlico sponsors gas via the paymaster.
 * No ETH needed anywhere.
 */
export async function deployCreatorCoin(
  params: CreatorCoinDeployParams,
  privateKey: Hex,
): Promise<CreatorCoinDeployResult> {
  const chainId = params.chainId ?? 8453;

  // 1. Get calldata from Zora API
  logger.info({
    creator: params.creator,
    name: params.metadata.name,
    symbol: params.metadata.symbol,
  }, "Fetching creator coin calldata from Zora API");

  const createResponse = await getCreatorCoinCalldata({
    creator: params.creator,
    name: params.metadata.name,
    symbol: params.metadata.symbol,
    metadataURI: params.metadata.metadataURI,
    chainId,
    ...(params.platformReferrer && { platformReferrer: params.platformReferrer }),
    ...(params.additionalOwners && { additionalOwners: params.additionalOwners }),
    ...(params.payoutRecipient && { payoutRecipientOverride: params.payoutRecipient }),
  });

  const call = createResponse.calls[0]!;
  logger.info({
    to: call.to,
    predicted: createResponse.predictedCoinAddress,
    smartWalletRouting: createResponse.usedSmartWalletRouting,
  }, "Got deployment calldata");

  // 2. Build and send UserOp via smart wallet + Pimlico
  const { createSponsoredBundlerClient } = await import("./bundler/config.js");

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });

  const smartAccount = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [account],
    address: params.creator,
    version: "1.1",
  });

  const bundlerClient = createSponsoredBundlerClient({
    account: smartAccount,
    chain: base,
    client: publicClient,
  });

  logger.info("Sending creator coin deployment as sponsored UserOp");

  const txHash = await bundlerClient.sendUserOperation({
    calls: [{
      to: call.to,
      data: call.data,
      value: BigInt(call.value),
    }],
  });

  logger.info({ userOpHash: txHash }, "UserOp submitted, waiting for receipt");

  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: txHash });

  if (!receipt.success) {
    throw new Error(`Creator coin deployment UserOp failed: ${txHash}`);
  }

  // 3. Parse coin address from receipt logs
  const { coinAddress } = parseCoinCreatedLogs(receipt.receipt.logs as Log[]);

  logger.info({
    coinAddress,
    txHash: receipt.receipt.transactionHash,
    predicted: createResponse.predictedCoinAddress,
  }, "🦞 Creator coin deployed!");

  return {
    coinAddress,
    predictedAddress: createResponse.predictedCoinAddress,
    txHash: receipt.receipt.transactionHash,
  };
}
