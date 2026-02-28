import test from "node:test";
import assert from "node:assert/strict";
import { dedupeAlertRows, type AlertRow } from "./alerts-dedupe.js";

test("dedupeAlertRows keeps one row per type+entity and prefers higher severity", () => {
  const rows: AlertRow[] = [
    { id: 1, type: "WATCHLIST_SUMMARY", entity_id: "0xabc", severity: "medium", message: "m1", created_at: "2026-02-15T00:00:00Z" },
    { id: 2, type: "WATCHLIST_SUMMARY", entity_id: "0xabc", severity: "high", message: "m2", created_at: "2026-02-15T00:01:00Z" },
    { id: 3, type: "WATCHLIST_SUMMARY", entity_id: "0xabc", severity: "medium", message: "m3", created_at: "2026-02-15T00:02:00Z" },
  ];

  const deduped = dedupeAlertRows(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 2);
});

test("dedupeAlertRows keeps latest when severity ties", () => {
  const rows: AlertRow[] = [
    { id: 10, type: "COIN_ACTIVITY_SPIKE", entity_id: "0xdef", severity: "high", message: "a", created_at: "2026-02-15T00:00:00Z" },
    { id: 12, type: "COIN_ACTIVITY_SPIKE", entity_id: "0xdef", severity: "high", message: "b", created_at: "2026-02-15T00:01:00Z" },
  ];

  const deduped = dedupeAlertRows(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 12);
});

test("dedupeAlertRows does not collapse different alert types for same coin", () => {
  const rows: AlertRow[] = [
    { id: 20, type: "WATCHLIST_SUMMARY", entity_id: "0xaaa", severity: "high", message: "a", created_at: "2026-02-15T00:00:00Z" },
    { id: 21, type: "COIN_ACTIVITY_SPIKE", entity_id: "0xaaa", severity: "high", message: "b", created_at: "2026-02-15T00:01:00Z" },
  ];

  const deduped = dedupeAlertRows(rows);
  assert.equal(deduped.length, 2);
});
