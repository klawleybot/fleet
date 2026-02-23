import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We test the pure logic of zoraSignals momentum functions by mocking the DB layer.
// Since the functions use `withZoraDb` internally with better-sqlite3, we mock the module.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Create an in-memory zora-intelligence DB for testing
function createTestZoraDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE coins (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      chain_id INTEGER,
      volume_24h REAL
    );
    CREATE TABLE coin_analytics (
      coin_address TEXT PRIMARY KEY,
      momentum_score REAL,
      momentum_score_1h REAL,
      momentum_acceleration_1h REAL,
      swap_count_1h INTEGER,
      swap_count_24h INTEGER,
      net_flow_usdc_1h REAL,
      net_flow_usdc_24h REAL,
      buy_count_1h INTEGER,
      sell_count_1h INTEGER
    );
    CREATE TABLE coin_watchlist (
      list_name TEXT,
      coin_address TEXT,
      label TEXT,
      notes TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (list_name, coin_address)
    );
    CREATE TABLE coin_swaps (
      id TEXT PRIMARY KEY,
      coin_address TEXT NOT NULL,
      chain_id INTEGER,
      tx_hash TEXT,
      block_timestamp TEXT,
      activity_type TEXT,
      sender_address TEXT,
      recipient_address TEXT,
      amount_decimal REAL,
      amount_usdc REAL,
      coin_amount REAL,
      raw_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      UNIQUE(coin_address, tx_hash, sender_address, recipient_address, block_timestamp)
    );
  `);
  return db;
}

let testDb: Database.Database;
let tmpDbPath: string;

beforeEach(() => {
  // Create a temp file-based DB so zoraSignals can open it
  tmpDbPath = path.join(process.cwd(), `test-zora-intel-${Date.now()}.db`);
  testDb = new Database(tmpDbPath);
  testDb.exec(`
    CREATE TABLE coins (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      chain_id INTEGER,
      volume_24h REAL
    );
    CREATE TABLE coin_analytics (
      coin_address TEXT PRIMARY KEY,
      momentum_score REAL,
      momentum_score_1h REAL,
      momentum_acceleration_1h REAL,
      swap_count_1h INTEGER,
      swap_count_24h INTEGER,
      net_flow_usdc_1h REAL,
      net_flow_usdc_24h REAL,
      buy_count_1h INTEGER,
      sell_count_1h INTEGER
    );
    CREATE TABLE coin_watchlist (
      list_name TEXT,
      coin_address TEXT,
      label TEXT,
      notes TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (list_name, coin_address)
    );
    CREATE TABLE coin_swaps (
      id TEXT PRIMARY KEY,
      coin_address TEXT NOT NULL,
      chain_id INTEGER,
      tx_hash TEXT,
      block_timestamp TEXT,
      activity_type TEXT,
      sender_address TEXT,
      recipient_address TEXT,
      amount_decimal REAL,
      amount_usdc REAL,
      coin_amount REAL,
      raw_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      UNIQUE(coin_address, tx_hash, sender_address, recipient_address, block_timestamp)
    );
  `);
  testDb.close();
  process.env.ZORA_INTEL_DB_PATH = tmpDbPath;
});

afterEach(() => {
  delete process.env.ZORA_INTEL_DB_PATH;
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

function seedDb(fn: (db: Database.Database) => void) {
  const db = new Database(tmpDbPath);
  fn(db);
  db.close();
}

const COIN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const COIN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const COIN_C = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const WALLET_1 = "0x1111111111111111111111111111111111111111";
const WALLET_2 = "0x2222222222222222222222222222222222222222";
const EXTERNAL = "0x9999999999999999999999999999999999999999";

describe("detectPumpSignals", () => {
  it("returns coins with high acceleration and positive net flow", async () => {
    seedDb((db) => {
      db.prepare("INSERT INTO coins VALUES (?, 'PUMP', 'PumpCoin', 8453, 1000)").run(COIN_A);
      db.prepare("INSERT INTO coin_analytics VALUES (?, 50, 30, 5.0, 100, 500, 200, 1000, 80, 20)").run(COIN_A);
      db.prepare("INSERT INTO coins VALUES (?, 'SLOW', 'SlowCoin', 8453, 500)").run(COIN_B);
      db.prepare("INSERT INTO coin_analytics VALUES (?, 20, 10, 1.0, 20, 100, 50, 300, 15, 5)").run(COIN_B);
    });

    const { detectPumpSignals } = await import("../src/services/zoraSignals.js");
    const signals = detectPumpSignals({
      coinAddresses: [COIN_A, COIN_B],
      accelerationThreshold: 3.0,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.coinAddress).toBe(COIN_A.toLowerCase());
    expect(signals[0]!.momentumAcceleration1h).toBe(5.0);
    expect(signals[0]!.netFlowUsdc1h).toBe(200);
  });

  it("returns empty when no coins match", async () => {
    seedDb((db) => {
      db.prepare("INSERT INTO coin_analytics VALUES (?, 20, 10, 1.0, 20, 100, -50, 300, 15, 5)").run(COIN_A);
    });

    const { detectPumpSignals } = await import("../src/services/zoraSignals.js");
    const signals = detectPumpSignals({
      coinAddresses: [COIN_A],
      accelerationThreshold: 3.0,
    });
    expect(signals).toHaveLength(0);
  });

  it("returns empty for empty input", async () => {
    const { detectPumpSignals } = await import("../src/services/zoraSignals.js");
    expect(detectPumpSignals({ coinAddresses: [] })).toHaveLength(0);
  });
});

describe("detectDipSignals", () => {
  it("returns watchlist coins with deceleration and negative flow", async () => {
    seedDb((db) => {
      db.prepare("INSERT INTO coins VALUES (?, 'DIP', 'DipCoin', 8453, 800)").run(COIN_A);
      db.prepare("INSERT INTO coin_analytics VALUES (?, 40, 20, 0.3, 50, 200, -150, 500, 20, 30)").run(COIN_A);
      db.prepare("INSERT INTO coin_watchlist VALUES ('default', ?, 'test', NULL, 1, ?, ?)").run(
        COIN_A, new Date().toISOString(), new Date().toISOString(),
      );
    });

    const { detectDipSignals } = await import("../src/services/zoraSignals.js");
    const signals = detectDipSignals({
      accelerationThreshold: 0.5,
      minSwapCount24h: 10,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.coinAddress).toBe(COIN_A.toLowerCase());
    expect(signals[0]!.momentumAcceleration1h).toBe(0.3);
    expect(signals[0]!.netFlowUsdc1h).toBe(-150);
  });

  it("returns previously traded coins with dip signals", async () => {
    seedDb((db) => {
      db.prepare("INSERT INTO coins VALUES (?, 'OLD', 'OldCoin', 8453, 600)").run(COIN_B);
      db.prepare("INSERT INTO coin_analytics VALUES (?, 30, 15, 0.2, 30, 150, -100, 400, 10, 20)").run(COIN_B);
    });

    const { detectDipSignals } = await import("../src/services/zoraSignals.js");
    const signals = detectDipSignals({
      previouslyTradedAddresses: [COIN_B],
      accelerationThreshold: 0.5,
      minSwapCount24h: 10,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.coinAddress).toBe(COIN_B.toLowerCase());
  });

  it("ignores coins with positive net flow", async () => {
    seedDb((db) => {
      db.prepare("INSERT INTO coins VALUES (?, 'UP', 'UpCoin', 8453, 800)").run(COIN_A);
      db.prepare("INSERT INTO coin_analytics VALUES (?, 40, 20, 0.3, 50, 200, 150, 500, 30, 20)").run(COIN_A);
      db.prepare("INSERT INTO coin_watchlist VALUES ('default', ?, 'test', NULL, 1, ?, ?)").run(
        COIN_A, new Date().toISOString(), new Date().toISOString(),
      );
    });

    const { detectDipSignals } = await import("../src/services/zoraSignals.js");
    const signals = detectDipSignals({ accelerationThreshold: 0.5 });
    expect(signals).toHaveLength(0);
  });

  it("deduplicates coins appearing in both watchlist and traded", async () => {
    seedDb((db) => {
      db.prepare("INSERT INTO coins VALUES (?, 'DUP', 'DupCoin', 8453, 800)").run(COIN_A);
      db.prepare("INSERT INTO coin_analytics VALUES (?, 40, 20, 0.3, 50, 200, -150, 500, 20, 30)").run(COIN_A);
      db.prepare("INSERT INTO coin_watchlist VALUES ('default', ?, 'test', NULL, 1, ?, ?)").run(
        COIN_A, new Date().toISOString(), new Date().toISOString(),
      );
    });

    const { detectDipSignals } = await import("../src/services/zoraSignals.js");
    const signals = detectDipSignals({
      previouslyTradedAddresses: [COIN_A],
      accelerationThreshold: 0.5,
      minSwapCount24h: 10,
    });

    expect(signals).toHaveLength(1);
  });
});

describe("discountOwnActivity", () => {
  it("returns 1.0 when no swaps exist", async () => {
    const { discountOwnActivity } = await import("../src/services/zoraSignals.js");
    const factor = discountOwnActivity(COIN_A, [WALLET_1]);
    expect(factor).toBe(1.0);
  });

  it("returns 1.0 when no own swaps", async () => {
    const now = new Date().toISOString();
    seedDb((db) => {
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0xabc', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "swap1", COIN_A, now, EXTERNAL, COIN_A, now,
      );
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0xdef', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "swap2", COIN_A, now, EXTERNAL, COIN_A, now,
      );
    });

    const { discountOwnActivity } = await import("../src/services/zoraSignals.js");
    const factor = discountOwnActivity(COIN_A, [WALLET_1]);
    expect(factor).toBe(1.0);
  });

  it("discounts when own wallets make swaps", async () => {
    const now = new Date().toISOString();
    seedDb((db) => {
      // 2 own swaps, 2 external = 50% own activity → discount 0.5
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0x1', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "s1", COIN_A, now, WALLET_1, COIN_A, now,
      );
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0x2', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "s2", COIN_A, now, WALLET_2, COIN_A, now,
      );
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0x3', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "s3", COIN_A, now, EXTERNAL, COIN_A, now,
      );
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0x4', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "s4", COIN_A, now, EXTERNAL, COIN_A, now,
      );
    });

    const { discountOwnActivity } = await import("../src/services/zoraSignals.js");
    const factor = discountOwnActivity(COIN_A, [WALLET_1, WALLET_2]);
    expect(factor).toBe(0.5);
  });

  it("returns 0.0 when all swaps are own", async () => {
    const now = new Date().toISOString();
    seedDb((db) => {
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0x1', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "s1", COIN_A, now, WALLET_1, COIN_A, now,
      );
    });

    const { discountOwnActivity } = await import("../src/services/zoraSignals.js");
    const factor = discountOwnActivity(COIN_A, [WALLET_1]);
    expect(factor).toBe(0);
  });

  it("returns 1.0 with empty wallet list", async () => {
    const { discountOwnActivity } = await import("../src/services/zoraSignals.js");
    const factor = discountOwnActivity(COIN_A, []);
    expect(factor).toBe(1.0);
  });

  it("ignores old swaps (>1h)", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedDb((db) => {
      db.prepare("INSERT INTO coin_swaps VALUES (?, ?, 8453, '0x1', ?, 'buy', ?, ?, 1.0, 10, 100, '{}', ?)").run(
        "s1", COIN_A, twoHoursAgo, WALLET_1, COIN_A, twoHoursAgo,
      );
    });

    const { discountOwnActivity } = await import("../src/services/zoraSignals.js");
    const factor = discountOwnActivity(COIN_A, [WALLET_1]);
    expect(factor).toBe(1.0);
  });
});
