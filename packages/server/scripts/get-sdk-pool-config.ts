import { setApiKey, createCoinCall } from "@zoralabs/coins-sdk";
import { coinFactoryABI } from "@zoralabs/protocol-deployments";
import { decodeFunctionData, decodeAbiParameters, parseAbiParameters, type Hex } from "viem";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
const DUMMY_URI = "ipfs://bafybeibtsltivt5tu423yxirtjirytjorlpgn6rk3jp3o7eplyhe6it544";

async function main() {
  setApiKey(process.env.ZORA_API_KEY!);
  
  const sdkResult = await createCoinCall({
    creator: SMART_WALLET as any,
    name: "Test",
    symbol: "TEST",
    metadata: { type: "RAW_URI", uri: DUMMY_URI },
    currency: "CREATOR_COIN",
    chainId: 8453,
    skipMetadataValidation: true,
  });

  const sdkCall = sdkResult.calls[0]!;
  const decoded = decodeFunctionData({ abi: coinFactoryABI, data: sdkCall.data });
  const sdkArgs = decoded.args as any[];
  const sdkPoolConfig = sdkArgs[5] as Hex;

  const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(
    parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"),
    sdkPoolConfig,
  );

  const minTick = Math.min(...tickLowers.map(Number));
  const curves = [];
  for (let i = 0; i < tickLowers.length; i++) {
    curves.push({
      rangeStart: +Math.pow(1.0001, Number(tickLowers[i]) - minTick).toFixed(4),
      rangeEnd: +Math.pow(1.0001, Number(tickUppers[i]) - minTick).toFixed(4),
      sharePercent: +(Number(shares[i]) / 1e18 * 100).toFixed(1),
      tickLower: Number(tickLowers[i]),
      tickUpper: Number(tickUppers[i]),
      numPositions: Number(numPositions[i]),
    });
  }
  const totalDisc = curves.reduce((a, c) => a + c.sharePercent, 0);
  console.log("Version:", Number(version));
  console.log("Currency:", currency);
  console.log("Curves:", curves.length);
  console.log("Discovery:", totalDisc.toFixed(1) + "% / Tail:", (100 - totalDisc).toFixed(1) + "%");
  curves.forEach((c, i) => console.log("  Curve " + (i + 1) + ":", JSON.stringify(c)));
  console.log("\nCURVE_JSON=" + JSON.stringify({ curves, totalDiscovery: totalDisc }));
}

main().catch(console.error);
