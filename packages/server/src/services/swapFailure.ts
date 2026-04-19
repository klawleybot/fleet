import { decodeErrorResult, type Hex } from "viem";

const knownSwapFailureAbi = [
  {
    name: "Error",
    type: "error",
    inputs: [{ name: "message", type: "string" }],
  },
  {
    name: "Panic",
    type: "error",
    inputs: [{ name: "code", type: "uint256" }],
  },
  {
    name: "V4TooLittleReceived",
    type: "error",
    inputs: [
      { name: "minAmountOutReceived", type: "uint256" },
      { name: "amountReceived", type: "uint256" },
    ],
  },
] as const;

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function extractRevertData(message: string): Hex | null {
  const trimmed = message.trim();
  if (/^0x[0-9a-fA-F]{8,}$/.test(trimmed)) {
    return trimmed as Hex;
  }

  const matches = trimmed.match(/0x[0-9a-fA-F]{8,}/g);
  if (!matches?.length) return null;
  const longest = matches.reduce((best, current) => (current.length > best.length ? current : best));
  return longest as Hex;
}

export function describeSwapFailure(message: string | null | undefined): string | null {
  if (!message) return null;

  const normalized = normalizeMessage(message);
  const revertData = extractRevertData(normalized);
  if (!revertData) {
    return normalized;
  }

  try {
    const decoded = decodeErrorResult({
      abi: knownSwapFailureAbi,
      data: revertData,
    });

    switch (decoded.errorName) {
      case "Error":
        return normalizeMessage(String(decoded.args[0] ?? "Execution reverted"));
      case "Panic":
        return `Execution panic: 0x${BigInt(decoded.args[0] ?? 0n).toString(16)}`;
      case "V4TooLittleReceived": {
        const minAmountOutReceived = BigInt(decoded.args[0] ?? 0n);
        const amountReceived = BigInt(decoded.args[1] ?? 0n);
        return (
          `Too little received: got ${amountReceived.toString()}, ` +
          `needed at least ${minAmountOutReceived.toString()}`
        );
      }
      default:
        return `Execution reverted (selector ${revertData.slice(0, 10)})`;
    }
  } catch {
    return normalized;
  }
}

export function isSlippageFailureMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("too little received") ||
    normalized.includes("v4toolittlereceived") ||
    normalized.includes("0x8b063d73")
  );
}
