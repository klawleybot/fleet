import { setApiKey, createCoinCall } from "@zoralabs/coins-sdk";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { decodeFunctionData, decodeAbiParameters, parseAbiParameters, type Hex } from "viem";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
const DUMMY_URI = "ipfs://bafybeibtsltivt5tu423yxirtjirytjorlpgn6rk3jp3o7eplyhe6it544";

async function getConfig(currency: string) {
  const result = await createCoinCall({
    creator: SMART_WALLET as any,
    name: "Test",
    symbol: "TEST",
    metadata: { type: "RAW_URI", uri: DUMMY_URI },
    currency: currency as any,
    chainId: 8453,
    skipMetadataValidation: true,
  });
  const call = result.calls[0]!;
  const decoded = decodeFunctionData({ abi: coinFactoryABI, data: call.data });
  const args = decoded.args as any[];
  const poolConfig = args[5] as Hex;
  const [ver, cur, tls, tus, nps, shs] = decodeAbiParameters(
    parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"),
    poolConfig,
  );
  const minTick = Math.min(...tls.map(Number));
  return {
    currency: cur as string,
    version: Number(ver),
    tickLowers: tls.map(Number),
    tickUppers: tus.map(Number),
    numPositions: nps.map(Number),
    shares: shs.map(s => +(Number(s) / 1e18 * 100).toFixed(1)),
    minTick,
    maxTick: Math.max(...tus.map(Number)),
    range: Math.pow(1.0001, Math.max(...tus.map(Number)) - minTick).toFixed(2) + "x",
  };
}

async function main() {
  setApiKey(process.env.ZORA_API_KEY!);
  
  for (const cur of ["CREATOR_COIN", "ZORA", "ETH"]) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Currency: ${cur}`);
    console.log("=".repeat(60));
    const cfg = await getConfig(cur);
    console.log("  Backing token:", cfg.currency);
    console.log("  Tick range: [", cfg.minTick, ",", cfg.maxTick, "] =", cfg.range);
    console.log("  Curves:", cfg.tickLowers.length);
    for (let i = 0; i < cfg.tickLowers.length; i++) {
      const rangeStart = Math.pow(1.0001, cfg.tickLowers[i] - cfg.minTick).toFixed(4);
      const rangeEnd = Math.pow(1.0001, cfg.tickUppers[i] - cfg.minTick).toFixed(4);
      console.log(`    Curve ${i+1}: ticks [${cfg.tickLowers[i]}, ${cfg.tickUppers[i]}] = ${rangeStart}x → ${rangeEnd}x, ${cfg.shares[i]}% supply, ${cfg.numPositions[i]} pos`);
    }
    console.log("  Total discovery:", cfg.shares.reduce((a, b) => a + b, 0).toFixed(1) + "%");
  }
}
main().catch(console.error);
