import { describe, expect, it, beforeEach } from "vitest";
import { isCoinInWatchlist, selectSignalCoin, topMovers, watchlistSignals } from "../src/services/zoraSignals.js";
import { seedCoin, seedAnalytics, seedWatchlist, cleanIntelDb } from "./intel-fixtures.js";

const ADDR_A = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const ADDR_B = "0x2222222222222222222222222222222222222222" as `0x${string}`;

beforeEach(() => {
  cleanIntelDb();
  seedCoin(ADDR_A, { symbol: "AAA", name: "A", volume24h: 1000 });
  seedCoin(ADDR_B, { symbol: "BBB", name: "B", volume24h: 2000 });
  seedAnalytics(ADDR_A, { momentumScore: 100, swapCount24h: 20, netFlowUsdc24h: 10 });
  seedAnalytics(ADDR_B, { momentumScore: 300, swapCount24h: 40, netFlowUsdc24h: 20 });
  seedWatchlist(ADDR_A, "wl");
});

describe("zora signal selectors", () => {
  it("returns top movers ordered by momentum", () => {
    const rows = topMovers({ limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0]?.coinAddress).toBe(ADDR_B);
  });

  it("returns watchlist candidates and watchlist membership", () => {
    const wl = watchlistSignals({ listName: "wl", limit: 5 });
    expect(wl.length).toBe(1);
    expect(isCoinInWatchlist(ADDR_A, "wl")).toBe(true);
    expect(isCoinInWatchlist(ADDR_B, "wl")).toBe(false);
  });

  it("selects best candidate by mode", () => {
    const coin = selectSignalCoin({ mode: "top_momentum" });
    expect(coin.coinAddress).toBe(ADDR_B);
  });
});
