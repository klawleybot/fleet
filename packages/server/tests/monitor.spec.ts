import { describe, it, expect } from "vitest";
import { recordTradePosition } from "../src/services/monitor.js";
import { db } from "../src/db/index.js";

const COIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

describe("monitor — position tracking", () => {
  // Since db is a singleton with in-memory-like behavior in tests,
  // we need a unique wallet for each test. Use createWallet.
  let walletCounter = 0;
  function createTestWallet() {
    walletCounter++;
    const id = `${Date.now()}-${walletCounter}`;
    const hex = Buffer.from(id).toString("hex").slice(0, 40).padEnd(40, "0");
    const addr = `0x${hex}` as `0x${string}`;
    return db.createWallet({
      name: `test-monitor-${id}`,
      address: addr,
      cdpAccountName: `cdp-mon-${id}`,
      ownerAddress: addr,
      type: "smart",
      isMaster: false,
    });
  }

  it("creates position on first buy", () => {
    const wallet = createTestWallet();
    const pos = recordTradePosition({
      walletId: wallet.id,
      coinAddress: COIN,
      isBuy: true,
      ethAmountWei: "1000000000000000", // 0.001 ETH
      tokenAmount: "5000000000000000000000", // 5000 tokens
    });

    expect(pos.buyCount).toBe(1);
    expect(pos.sellCount).toBe(0);
    expect(pos.totalCostWei).toBe("1000000000000000");
    expect(pos.holdingsRaw).toBe("5000000000000000000000");
  });

  it("accumulates on multiple buys", () => {
    const wallet = createTestWallet();
    recordTradePosition({
      walletId: wallet.id,
      coinAddress: COIN,
      isBuy: true,
      ethAmountWei: "1000000000000000",
      tokenAmount: "5000000000000000000000",
    });

    const pos = recordTradePosition({
      walletId: wallet.id,
      coinAddress: COIN,
      isBuy: true,
      ethAmountWei: "2000000000000000",
      tokenAmount: "8000000000000000000000",
    });

    expect(pos.buyCount).toBe(2);
    expect(pos.totalCostWei).toBe("3000000000000000");
    expect(pos.holdingsRaw).toBe("13000000000000000000000");
  });

  it("tracks sell reducing holdings", () => {
    const wallet = createTestWallet();
    recordTradePosition({
      walletId: wallet.id,
      coinAddress: COIN,
      isBuy: true,
      ethAmountWei: "1000000000000000",
      tokenAmount: "5000000000000000000000",
    });

    const pos = recordTradePosition({
      walletId: wallet.id,
      coinAddress: COIN,
      isBuy: false,
      ethAmountWei: "800000000000000", // got 0.0008 ETH back
      tokenAmount: "3000000000000000000000", // sold 3000 tokens
    });

    expect(pos.buyCount).toBe(1);
    expect(pos.sellCount).toBe(1);
    expect(pos.totalCostWei).toBe("1000000000000000");
    expect(pos.totalReceivedWei).toBe("800000000000000");
    expect(pos.holdingsRaw).toBe("2000000000000000000000"); // 5000 - 3000
  });

  it("maintains separate positions per coin", () => {
    const wallet = createTestWallet();
    const coin2 = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

    recordTradePosition({
      walletId: wallet.id,
      coinAddress: COIN,
      isBuy: true,
      ethAmountWei: "1000000000000000",
      tokenAmount: "5000000000000000000000",
    });

    recordTradePosition({
      walletId: wallet.id,
      coinAddress: coin2,
      isBuy: true,
      ethAmountWei: "2000000000000000",
      tokenAmount: "10000000000000000000000",
    });

    const positions = db.listPositionsByWallet(wallet.id);
    expect(positions.length).toBe(2);
  });

  it("db queries work — listPositionsByCoin", () => {
    const wallet = createTestWallet();
    const sharedCoin = "0xdddddddddddddddddddddddddddddddddddddd" as `0x${string}`;

    recordTradePosition({
      walletId: wallet.id,
      coinAddress: sharedCoin,
      isBuy: true,
      ethAmountWei: "500000000000000",
      tokenAmount: "1000000000000000000000",
    });

    const positions = db.listPositionsByCoin(sharedCoin);
    expect(positions.length).toBeGreaterThanOrEqual(1);
    expect(positions[0]!.coinAddress.toLowerCase()).toBe(sharedCoin.toLowerCase());
  });

  it("trade record includes amountOut and operationId", () => {
    const wallet = createTestWallet();
    const trade = db.createTrade({
      walletId: wallet.id,
      fromToken: "0x0000000000000000000000000000000000000000",
      toToken: COIN,
      amountIn: "1000000000000000",
      amountOut: "5000000000000000000000",
      operationId: null,
      userOpHash: null,
      txHash: null,
      status: "complete",
      errorMessage: null,
    });

    expect(trade.amountOut).toBe("5000000000000000000000");
    expect(trade.operationId).toBeNull();
  });
});
