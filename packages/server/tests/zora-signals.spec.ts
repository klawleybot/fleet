import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isCoinInWatchlist, selectSignalCoin, topMovers, watchlistSignals } from "../src/services/zoraSignals.js";

let tmpDir = "";

function makeFixtureDb() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "zora-signals-spec-"));
  const dbPath = path.join(tmpDir, "zora.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE coins (address TEXT PRIMARY KEY, symbol TEXT, name TEXT, chain_id INTEGER, volume_24h REAL);
    CREATE TABLE coin_analytics (coin_address TEXT PRIMARY KEY, momentum_score REAL, swap_count_24h INTEGER, net_flow_usdc_24h REAL);
    CREATE TABLE coin_watchlist (list_name TEXT NOT NULL, coin_address TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(list_name, coin_address));
  `);

  db.prepare("INSERT INTO coins(address,symbol,name,chain_id,volume_24h) VALUES(?,?,?,?,?)")
    .run("0x1111111111111111111111111111111111111111", "AAA", "A", 84532, 1000);
  db.prepare("INSERT INTO coins(address,symbol,name,chain_id,volume_24h) VALUES(?,?,?,?,?)")
    .run("0x2222222222222222222222222222222222222222", "BBB", "B", 84532, 2000);

  db.prepare("INSERT INTO coin_analytics(coin_address,momentum_score,swap_count_24h,net_flow_usdc_24h) VALUES(?,?,?,?)")
    .run("0x1111111111111111111111111111111111111111", 100, 20, 10);
  db.prepare("INSERT INTO coin_analytics(coin_address,momentum_score,swap_count_24h,net_flow_usdc_24h) VALUES(?,?,?,?)")
    .run("0x2222222222222222222222222222222222222222", 300, 40, 20);

  db.prepare("INSERT INTO coin_watchlist(list_name,coin_address,enabled) VALUES(?,?,1)")
    .run("wl", "0x1111111111111111111111111111111111111111");

  db.close();
  process.env.ZORA_INTEL_DB_PATH = dbPath;
}

afterEach(() => {
  delete process.env.ZORA_INTEL_DB_PATH;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

describe("zora signal selectors", () => {
  it("returns top movers ordered by momentum", () => {
    makeFixtureDb();
    const rows = topMovers({ limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0]?.coinAddress).toBe("0x2222222222222222222222222222222222222222");
  });

  it("returns watchlist candidates and watchlist membership", () => {
    makeFixtureDb();
    const wl = watchlistSignals({ listName: "wl", limit: 5 });
    expect(wl.length).toBe(1);
    expect(isCoinInWatchlist("0x1111111111111111111111111111111111111111")).toBe(true);
    expect(isCoinInWatchlist("0x2222222222222222222222222222222222222222")).toBe(false);
  });

  it("selects best candidate by mode", () => {
    makeFixtureDb();
    const top = selectSignalCoin({ mode: "top_momentum" });
    expect(top.coinAddress).toBe("0x2222222222222222222222222222222222222222");
    const watch = selectSignalCoin({ mode: "watchlist_top", listName: "wl" });
    expect(watch.coinAddress).toBe("0x1111111111111111111111111111111111111111");
  });
});
