import { describe, expect, it } from "vitest";
import { parseOperationPayload, parseOperationResult } from "./operations";
import type { OperationRecord } from "../types";

function makeOperation(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    id: 42,
    type: "SUPPORT_COIN",
    clusterId: 3,
    status: "pending",
    requestedBy: "web-operator",
    approvedBy: null,
    payloadJson: "{}",
    resultJson: null,
    errorMessage: null,
    createdAt: "2026-04-18T12:00:00.000Z",
    updatedAt: "2026-04-18T12:01:00.000Z",
    ...overrides,
  };
}

describe("parseOperationPayload", () => {
  it("parses funding request payloads", () => {
    const operation = makeOperation({
      type: "FUNDING_REQUEST",
      payloadJson: JSON.stringify({ amountWei: "123000000000000000" }),
    });

    expect(parseOperationPayload(operation)).toEqual({
      kind: "funding",
      amountWei: "123000000000000000",
    });
  });

  it("parses trade payloads with signal metadata", () => {
    const operation = makeOperation({
      payloadJson: JSON.stringify({
        coinAddress: "0x1234567890abcdef1234567890abcdef12345678",
        totalAmountWei: "10000000000000000",
        slippageBps: 150,
        strategyMode: "sync",
        signal: {
          mode: "watchlist_top",
          coinUrl: "https://zora.co/coin/123",
          momentumScore: 81.2,
        },
      }),
    });

    expect(parseOperationPayload(operation)).toEqual({
      kind: "trade",
      coinAddress: "0x1234567890abcdef1234567890abcdef12345678",
      totalAmountWei: "10000000000000000",
      slippageBps: 150,
      strategyMode: "sync",
      signal: {
        mode: "watchlist_top",
        coinUrl: "https://zora.co/coin/123",
        momentumScore: 81.2,
      },
    });
  });

  it("falls back to unknown when payload shape does not match the operation type", () => {
    const operation = makeOperation({
      type: "EXIT_COIN",
      payloadJson: JSON.stringify({ amountWei: "123" }),
    });

    expect(parseOperationPayload(operation)).toEqual({
      kind: "unknown",
      raw: { amountWei: "123" },
    });
  });
});

describe("parseOperationResult", () => {
  it("parses funding results", () => {
    const operation = makeOperation({
      type: "FUNDING_REQUEST",
      resultJson: JSON.stringify({
        fundingCount: 2,
        fundingRecords: [
          {
            id: 7,
            fromWalletId: 1,
            toWalletId: 2,
            amountWei: "100",
            userOpHash: null,
            txHash: null,
            status: "pending",
            errorMessage: null,
            createdAt: "2026-04-18T12:00:00.000Z",
          },
        ],
      }),
    });

    expect(parseOperationResult(operation)).toEqual({
      kind: "funding",
      fundingCount: 2,
      fundingRecords: [
        {
          id: 7,
          fromWalletId: 1,
          toWalletId: 2,
          amountWei: "100",
          userOpHash: null,
          txHash: null,
          status: "pending",
          errorMessage: null,
          createdAt: "2026-04-18T12:00:00.000Z",
        },
      ],
    });
  });

  it("parses trade results", () => {
    const operation = makeOperation({
      resultJson: JSON.stringify({
        tradeCount: 1,
        trades: [
          {
            id: 9,
            walletId: 4,
            fromToken: "0x4200000000000000000000000000000000000006",
            toToken: "0x1234567890abcdef1234567890abcdef12345678",
            amountIn: "1000",
            amountOut: "999",
            operationId: 42,
            userOpHash: null,
            txHash: null,
            status: "complete",
            errorMessage: null,
            createdAt: "2026-04-18T12:00:00.000Z",
          },
        ],
      }),
    });

    expect(parseOperationResult(operation)).toEqual({
      kind: "trade",
      tradeCount: 1,
      trades: [
        {
          id: 9,
          walletId: 4,
          fromToken: "0x4200000000000000000000000000000000000006",
          toToken: "0x1234567890abcdef1234567890abcdef12345678",
          amountIn: "1000",
          amountOut: "999",
          operationId: 42,
          userOpHash: null,
          txHash: null,
          status: "complete",
          errorMessage: null,
          createdAt: "2026-04-18T12:00:00.000Z",
        },
      ],
    });
  });
});
