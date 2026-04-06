import test from "node:test";
import assert from "node:assert/strict";
import { selectDiverseAlerts, type DiversityOptions } from "./alerts-diversity.js";

const opts: DiversityOptions = {
  enabled: true,
  perCoinCooldownMin: 30,
  maxPerCoinPerDispatch: 1,
  noveltyWindowHours: 12,
  largeCapPenaltyAboveUsd: 1_000_000,
};

test("selectDiverseAlerts enforces max per coin", () => {
  const rows = [
    { id: 10, type: "A", entity_id: "0x1", severity: "high", message: "" },
    { id: 9, type: "B", entity_id: "0x1", severity: "medium", message: "" },
    { id: 8, type: "A", entity_id: "0x2", severity: "medium", message: "" },
  ];
  const out = selectDiverseAlerts(rows, 3, opts, new Map());
  assert.equal(out.length, 2);
  assert.equal(out.filter((r) => r.entity_id === "0x1").length, 1);
});

test("selectDiverseAlerts respects cooldown for repeated alerts", () => {
  const rows = [
    { id: 10, type: "A", entity_id: "0x1", severity: "medium", message: "" },
    { id: 9, type: "A", entity_id: "0x2", severity: "medium", message: "" },
  ];
  const meta = new Map<string, { lastSentAt?: string | null; recentCount?: number }>([
    ["0x1", { lastSentAt: new Date().toISOString(), recentCount: 1 }],
  ]);
  const out = selectDiverseAlerts(rows, 2, opts, meta);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.entity_id, "0x2");
});

test("selectDiverseAlerts also cooldown-blocks repeated high severity alerts", () => {
  const rows = [{ id: 10, type: "A", entity_id: "0x1", severity: "high", message: "" }];
  const meta = new Map<string, { lastSentAt?: string | null; recentCount?: number }>([
    ["0x1", { lastSentAt: new Date().toISOString(), recentCount: 2 }],
  ]);
  const out = selectDiverseAlerts(rows, 1, opts, meta);
  assert.equal(out.length, 0);
});


test("selectDiverseAlerts allows first-time alerts through cooldown window", () => {
  const rows = [{ id: 10, type: "A", entity_id: "0x1", severity: "high", message: "" }];
  const meta = new Map<string, { lastSentAt?: string | null; recentCount?: number }>([
    ["0x1", { lastSentAt: new Date().toISOString(), recentCount: 0 }],
  ]);
  const out = selectDiverseAlerts(rows, 1, opts, meta);
  assert.equal(out.length, 1);
});
