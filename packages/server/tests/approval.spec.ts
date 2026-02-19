import { afterEach, describe, expect, it } from "vitest";
import { evaluateAutoApproval } from "../src/services/approval.js";
import type { OperationRecord } from "../src/types.js";

const baseOp: OperationRecord = {
  id: 1,
  type: "SUPPORT_COIN",
  clusterId: 1,
  status: "pending",
  requestedBy: "autonomy-worker",
  approvedBy: null,
  payloadJson: JSON.stringify({ totalAmountWei: "100" }),
  resultJson: null,
  errorMessage: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  withEnv({
    AUTO_APPROVE_ENABLED: undefined,
    AUTO_APPROVE_REQUESTERS: undefined,
    AUTO_APPROVE_OPERATION_TYPES: undefined,
    AUTO_APPROVE_MAX_TRADE_WEI: undefined,
    AUTO_APPROVE_MAX_FUNDING_WEI: undefined,
  });
});

describe("auto-approval policy", () => {
  it("approves allowed requester/type/amount", () => {
    withEnv({
      AUTO_APPROVE_ENABLED: "true",
      AUTO_APPROVE_REQUESTERS: "autonomy-worker",
      AUTO_APPROVE_OPERATION_TYPES: "SUPPORT_COIN",
      AUTO_APPROVE_MAX_TRADE_WEI: "1000",
    });

    const decision = evaluateAutoApproval(baseOp);
    expect(decision.allow).toBe(true);
  });

  it("rejects disallowed requester", () => {
    withEnv({
      AUTO_APPROVE_ENABLED: "true",
      AUTO_APPROVE_REQUESTERS: "someone-else",
      AUTO_APPROVE_OPERATION_TYPES: "SUPPORT_COIN",
      AUTO_APPROVE_MAX_TRADE_WEI: "1000",
    });

    const decision = evaluateAutoApproval(baseOp);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("not in AUTO_APPROVE_REQUESTERS");
  });

  it("rejects amount over threshold", () => {
    withEnv({
      AUTO_APPROVE_ENABLED: "true",
      AUTO_APPROVE_REQUESTERS: "autonomy-worker",
      AUTO_APPROVE_OPERATION_TYPES: "SUPPORT_COIN",
      AUTO_APPROVE_MAX_TRADE_WEI: "10",
    });

    const decision = evaluateAutoApproval(baseOp);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("AUTO_APPROVE_MAX_TRADE_WEI");
  });
});
