import { base, baseSepolia } from "viem/chains";

export type AppNetwork = "base" | "base-sepolia";

function normalizeNetwork(value: string | undefined): AppNetwork {
  const normalized = (value ?? "base").trim().toLowerCase();
  if (normalized === "base-sepolia" || normalized === "basesepolia") return "base-sepolia";
  return "base";
}

export function getAppNetwork(): AppNetwork {
  return normalizeNetwork(process.env.APP_NETWORK);
}

export function getChainConfig() {
  const network = getAppNetwork();
  if (network === "base-sepolia") {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_RPC_URL || "https://sepolia.base.org";
    return {
      network,
      chain: baseSepolia,
      chainId: 84532,
      rpcUrl,
      cdpNetwork: "base-sepolia" as const,
    };
  }

  const rpcUrl = process.env.BASE_RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || "https://mainnet.base.org";
  return {
    network,
    chain: base,
    chainId: 8453,
    rpcUrl,
    cdpNetwork: "base" as const,
  };
}
