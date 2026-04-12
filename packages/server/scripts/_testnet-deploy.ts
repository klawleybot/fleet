/**
 * Testnet deploy: custom Doppler curve on Base Sepolia.
 * Run with: doppler run --project openclaw --config dev -- bun x tsx scripts/_testnet-deploy.ts
 */
import { encodePoolConfig, PROFILES, computeLaunchTick } from "../src/services/poolConfig.js";
import { createSponsoredBundlerClient } from "../src/services/bundler/config.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, encodeFunctionData, parseEther, type Log, parseEventLogs } from "viem";
import type { Address, Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";

const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;
const WETH_SEPOLIA = "0x4200000000000000000000000000000000000006" as Address;
// On Sepolia, let viem compute the SA address (different from mainnet)
let KLAWLEY_SA: Address;

const deployAbi = [{
  type: "function" as const, name: "deploy" as const,
  inputs: [
    { name: "payoutRecipient", type: "address" as const },
    { name: "owners", type: "address[]" as const },
    { name: "uri", type: "string" as const },
    { name: "name", type: "string" as const },
    { name: "symbol", type: "string" as const },
    { name: "poolConfig", type: "bytes" as const },
    { name: "platformReferrer", type: "address" as const },
    { name: "orderSize", type: "uint256" as const },
  ],
  outputs: [{ name: "", type: "address" as const }, { name: "", type: "uint256" as const }],
  stateMutability: "payable" as const,
}] as const;

const coinCreatedAbi = [{
  type: "event" as const, anonymous: false, name: "CoinCreatedV4" as const,
  inputs: [
    { name: "caller", type: "address" as const, indexed: true },
    { name: "payoutRecipient", type: "address" as const, indexed: true },
    { name: "platformReferrer", type: "address" as const, indexed: true },
    { name: "currency", type: "address" as const, indexed: false },
    { name: "uri", type: "string" as const, indexed: false },
    { name: "name", type: "string" as const, indexed: false },
    { name: "symbol", type: "string" as const, indexed: false },
    { name: "coin", type: "address" as const, indexed: false },
    { name: "poolKey", type: "tuple" as const, components: [
      { name: "currency0", type: "address" as const },
      { name: "currency1", type: "address" as const },
      { name: "fee", type: "uint24" as const },
      { name: "tickSpacing", type: "int24" as const },
      { name: "hooks", type: "address" as const },
    ], indexed: false },
    { name: "poolKeyHash", type: "bytes32" as const, indexed: false },
    { name: "version", type: "string" as const, indexed: false },
  ],
}] as const;

async function main() {
  const privateKeyRaw = process.env.ZORA_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("ZORA_PRIVATE_KEY not set");

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const account = privateKeyToAccount(privateKey);

  const profileName = process.env.POOL_PROFILE || "rocket";
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown profile: ${profileName}. Available: ${Object.keys(PROFILES).join(", ")}`);

  console.log("═══ TESTNET DEPLOY: Custom Doppler Curve ═══");
  console.log(`Profile: ${profile.name}`);
  console.log(`Network: Base Sepolia (chain ${process.env.CHAIN_ID})`);

  // Build custom poolConfig for ETH-backed coin
  const launchTick = computeLaunchTick(2500, 100); // $100 MC at ETH=$2500
  console.log(`Launch tick: ${launchTick}`);

  const poolConfig = encodePoolConfig({ currency: WETH_SEPOLIA, profile, launchTick });
  console.log(`Pool config: ${poolConfig.length} chars`);

  const coinName = `Rocket Test ${Date.now() % 10000}`;
  const coinSymbol = "RKTST";
  const metadataURI = "ipfs://bafkreihl44bu34vpqrwmak5uy6xdasvnaqoxgpgwxwcpyyra5q2oorkmme";

  console.log(`\n🚀 Deploying "${coinName}"...`);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

  // Compute SA address for Sepolia (different from mainnet)
  const smartAccount = await toCoinbaseSmartAccount({
    client: publicClient, owners: [account],
  });
  KLAWLEY_SA = smartAccount.address;
  console.log(`SA address (Sepolia): ${KLAWLEY_SA}`);

  const balance = await publicClient.getBalance({ address: KLAWLEY_SA });
  console.log(`SA balance: ${Number(balance) / 1e18} ETH`);

  // Build calldata with the correct SA address
  const calldata = encodeFunctionData({
    abi: deployAbi, functionName: "deploy",
    args: [KLAWLEY_SA, [KLAWLEY_SA], metadataURI, coinName, coinSymbol, poolConfig,
      "0x0000000000000000000000000000000000000000" as Address, 0n],
  });

  const bundlerClient = createSponsoredBundlerClient({
    account: smartAccount, chain: baseSepolia, client: publicClient,
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    calls: [{ to: FACTORY, data: calldata, value: 0n }],
  });

  console.log("  UserOp:", userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });

  if (!receipt.success) { console.error("❌ Failed:", userOpHash); process.exit(1); }

  const events = parseEventLogs({ abi: coinCreatedAbi, logs: receipt.receipt.logs as Log[] });
  const created = events.find(e => e.eventName === "CoinCreatedV4");

  console.log("\n🎉 Deployed on Sepolia!");
  console.log(`  Coin: ${created?.args?.coin}`);
  console.log(`  Currency: ${created?.args?.currency}`);
  console.log(`  TX: ${receipt.receipt.transactionHash}`);
  console.log(`  Explorer: https://sepolia.basescan.org/tx/${receipt.receipt.transactionHash}`);
}

main().catch(err => { console.error("❌", err.message || err); process.exit(1); });
