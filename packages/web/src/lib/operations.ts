import type {
  FundingRecord,
  OperationRecord,
  TradeRecord,
  ZoraSignalMode,
} from "../types";

export type ParsedOperationPayload =
  | {
      kind: "funding";
      amountWei: string;
    }
  | {
      kind: "trade";
      coinAddress: `0x${string}`;
      totalAmountWei: string;
      slippageBps: number;
      strategyMode: "sync" | "staggered" | "momentum";
      signal?: {
        mode: ZoraSignalMode;
        coinUrl: string;
        momentumScore: number;
      };
    }
  | {
      kind: "unknown";
      raw: unknown;
    };

export type ParsedOperationResult =
  | {
      kind: "funding";
      fundingCount: number;
      fundingRecords: FundingRecord[];
    }
  | {
      kind: "trade";
      tradeCount: number;
      trades: TradeRecord[];
    }
  | {
      kind: "unknown";
      raw: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parseOperationPayload(operation: OperationRecord): ParsedOperationPayload {
  const parsed = parseJson(operation.payloadJson);
  if (!isRecord(parsed)) {
    return { kind: "unknown", raw: parsed };
  }

  if (operation.type === "FUNDING_REQUEST" && typeof parsed.amountWei === "string") {
    return {
      kind: "funding",
      amountWei: parsed.amountWei,
    };
  }

  if (
    (operation.type === "SUPPORT_COIN" || operation.type === "EXIT_COIN") &&
    typeof parsed.coinAddress === "string" &&
    typeof parsed.totalAmountWei === "string" &&
    typeof parsed.slippageBps === "number" &&
    typeof parsed.strategyMode === "string"
  ) {
    const signal = isRecord(parsed.signal) &&
      typeof parsed.signal.mode === "string" &&
      typeof parsed.signal.coinUrl === "string" &&
      typeof parsed.signal.momentumScore === "number"
      ? {
          mode: parsed.signal.mode as ZoraSignalMode,
          coinUrl: parsed.signal.coinUrl,
          momentumScore: parsed.signal.momentumScore,
        }
      : undefined;

    return {
      kind: "trade",
      coinAddress: parsed.coinAddress.toLowerCase() as `0x${string}`,
      totalAmountWei: parsed.totalAmountWei,
      slippageBps: parsed.slippageBps,
      strategyMode: parsed.strategyMode as "sync" | "staggered" | "momentum",
      ...(signal ? { signal } : {}),
    };
  }

  return { kind: "unknown", raw: parsed };
}

export function parseOperationResult(operation: OperationRecord): ParsedOperationResult {
  const parsed = parseJson(operation.resultJson);
  if (!isRecord(parsed)) {
    return { kind: "unknown", raw: parsed };
  }

  if (operation.type === "FUNDING_REQUEST" && typeof parsed.fundingCount === "number") {
    return {
      kind: "funding",
      fundingCount: parsed.fundingCount,
      fundingRecords: Array.isArray(parsed.fundingRecords) ? (parsed.fundingRecords as FundingRecord[]) : [],
    };
  }

  if (
    (operation.type === "SUPPORT_COIN" || operation.type === "EXIT_COIN") &&
    typeof parsed.tradeCount === "number"
  ) {
    return {
      kind: "trade",
      tradeCount: parsed.tradeCount,
      trades: Array.isArray(parsed.trades) ? (parsed.trades as TradeRecord[]) : [],
    };
  }

  return { kind: "unknown", raw: parsed };
}
