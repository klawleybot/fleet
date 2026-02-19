import type { OperationRecord, OperationType } from "../types.js";

interface AutoApprovalPolicy {
  enabled: boolean;
  approver: string;
  allowedRequesters: Set<string>;
  allowedOperationTypes: Set<OperationType>;
  maxFundingWei: bigint;
  maxTradeWei: bigint;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseBigInt(value: string | undefined, fallback: bigint): bigint {
  if (!value?.trim()) return fallback;
  try {
    const n = BigInt(value.trim());
    return n >= 0n ? n : fallback;
  } catch {
    return fallback;
  }
}

function parseSet(value: string | undefined): Set<string> {
  if (!value?.trim()) return new Set();
  return new Set(value.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
}

function parseOperationSet(value: string | undefined): Set<OperationType> {
  const allowed: OperationType[] = ["FUNDING_REQUEST", "SUPPORT_COIN", "EXIT_COIN"];
  if (!value?.trim()) return new Set(["SUPPORT_COIN"]);
  const raw = value.split(",").map((v) => v.trim().toUpperCase());
  return new Set(raw.filter((v): v is OperationType => allowed.includes(v as OperationType)));
}

export function getAutoApprovalPolicy(): AutoApprovalPolicy {
  return {
    enabled: parseBool(process.env.AUTO_APPROVE_ENABLED, false),
    approver: process.env.AUTO_APPROVE_APPROVER?.trim() || "autonomy-auto",
    allowedRequesters: parseSet(process.env.AUTO_APPROVE_REQUESTERS),
    allowedOperationTypes: parseOperationSet(process.env.AUTO_APPROVE_OPERATION_TYPES),
    maxFundingWei: parseBigInt(process.env.AUTO_APPROVE_MAX_FUNDING_WEI, 1_000_000_000_000_000n),
    maxTradeWei: parseBigInt(process.env.AUTO_APPROVE_MAX_TRADE_WEI, 1_000_000_000_000_000n),
  };
}

function extractAmountWei(operation: OperationRecord): bigint | null {
  try {
    const payload = JSON.parse(operation.payloadJson) as { amountWei?: string; totalAmountWei?: string };
    if (operation.type === "FUNDING_REQUEST" && payload.amountWei) return BigInt(payload.amountWei);
    if ((operation.type === "SUPPORT_COIN" || operation.type === "EXIT_COIN") && payload.totalAmountWei) {
      return BigInt(payload.totalAmountWei);
    }
    return null;
  } catch {
    return null;
  }
}

export function evaluateAutoApproval(operation: OperationRecord): { allow: boolean; reason: string } {
  const policy = getAutoApprovalPolicy();
  if (!policy.enabled) return { allow: false, reason: "AUTO_APPROVE_ENABLED is false" };

  if (!policy.allowedOperationTypes.has(operation.type)) {
    return { allow: false, reason: `Operation type ${operation.type} is not auto-approvable` };
  }

  const requester = (operation.requestedBy ?? "").trim().toLowerCase();
  if (policy.allowedRequesters.size > 0 && !policy.allowedRequesters.has(requester)) {
    return { allow: false, reason: `Requester ${operation.requestedBy ?? "unknown"} not in AUTO_APPROVE_REQUESTERS` };
  }

  const amountWei = extractAmountWei(operation);
  if (amountWei === null) {
    return { allow: false, reason: "Could not parse operation amount" };
  }

  if (operation.type === "FUNDING_REQUEST" && amountWei > policy.maxFundingWei) {
    return { allow: false, reason: `Funding amount exceeds AUTO_APPROVE_MAX_FUNDING_WEI (${policy.maxFundingWei.toString()})` };
  }

  if ((operation.type === "SUPPORT_COIN" || operation.type === "EXIT_COIN") && amountWei > policy.maxTradeWei) {
    return { allow: false, reason: `Trade amount exceeds AUTO_APPROVE_MAX_TRADE_WEI (${policy.maxTradeWei.toString()})` };
  }

  return { allow: true, reason: "auto-approved" };
}
