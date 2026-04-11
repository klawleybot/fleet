/**
 * Test using the SDK's createCoinCall to get correct deploy calldata
 * for a content coin paired to a specific currency.
 */
import { createCoinCall, setApiKey } from "@zoralabs/coins-sdk";
import { decodeAbiParameters, parseAbiParameters, decodeFunctionData, type Hex } from "viem";

const SMART_WALLET = "0x097677d3e2cde65af10be80ae5e67b8b68eb613d";
const OPENCLAW_TREND = "0x1742c7d9d55f7279009fc85041b269ba5f368a71";

async function main() {
  setApiKey(process.env.ZORA_API_KEY!);

  console.log("Calling createCoinCall with CREATOR_COIN currency...");
  
  const result = await createCoinCall({
    creator: SMART_WALLET,
    name: "Test Trend Content",
    symbol: "TTC",
    metadata: {
      type: "RAW_URI",
      uri: "ipfs://bafybeibtsltivt5tu423yxirtjirytjorlpgn6rk3jp3o7eplyhe6it544",
    },
    currency: "CREATOR_COIN",
    chainId: 8453,
    skipMetadataValidation: true,
  });

  console.log("Predicted coin address:", result.predictedCoinAddress);
  console.log("Number of calls:", result.calls.length);
  
  for (const call of result.calls) {
    console.log("\nCall to:", call.to);
    console.log("Value:", call.value.toString());
    console.log("Data length:", call.data.length);
    
    // Try to decode the factory deploy call
    const deployAbi = [{
      type: "function", name: "deploy",
      inputs: [
        { name: "payoutRecipient", type: "address" },
        { name: "owners", type: "address[]" },
        { name: "uri", type: "string" },
        { name: "name", type: "string" },
        { name: "symbol", type: "string" },
        { name: "poolConfig", type: "bytes" },
        { name: "platformReferrer", type: "address" },
        { name: "orderSize", type: "uint256" },
      ],
      outputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }],
      stateMutability: "payable",
    }] as const;

    try {
      const decoded = decodeFunctionData({ abi: deployAbi, data: call.data });
      console.log("\nDecoded deploy call:");
      console.log("  payoutRecipient:", decoded.args[0]);
      console.log("  owners:", decoded.args[1]);
      console.log("  name:", decoded.args[3]);
      console.log("  symbol:", decoded.args[4]);
      console.log("  orderSize:", decoded.args[7].toString());
      
      // Decode the poolConfig bytes
      const poolConfig = decoded.args[5] as Hex;
      console.log("  poolConfig length:", poolConfig.length);
      
      const [version, currency, tickLowers, tickUppers, numPositions, shares] = decodeAbiParameters(
        parseAbiParameters("uint8, address, int24[], int24[], uint16[], uint256[]"),
        poolConfig,
      );
      
      console.log("\n  Pool Config:");
      console.log("    version:", version);
      console.log("    currency:", currency);
      console.log("    tickLowers:", tickLowers.map(Number));
      console.log("    tickUppers:", tickUppers.map(Number));
      console.log("    numPositions:", numPositions.map(Number));
      console.log("    shares:", shares.map(s => `${(Number(s) / 1e18 * 100).toFixed(1)}%`));
    } catch (e: any) {
      console.log("Could not decode as 8-param deploy:", e.message?.slice(0, 100));
    }
  }
}

main().catch(console.error);
