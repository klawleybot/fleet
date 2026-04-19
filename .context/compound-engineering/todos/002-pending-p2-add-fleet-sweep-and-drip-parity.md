---
status: pending
priority: p2
issue_id: "002"
tags: [web, fleets, parity]
dependencies: []
---

# Add Fleet Sweep And Drip Parity

Close the web parity gap for advanced fleet creation and trading flows that already exist on the backend.

## Problem Statement

The backend supports richer fleet workflows than the web exposes today. Operators can create funded fleets, use source-fleet funding, choose strategy modes, run drip trades with jiggle controls, and sweep balances, but the current web controls only cover a simplified subset.

## Findings

- Advanced create options exist at `packages/server/src/routes/fleets.ts:22`.
- Fleet buy/sell supports `overMs`, `intervals`, `jiggle`, and `jiggleFactor` at `packages/server/src/routes/fleets.ts:30`.
- Fleet sweep exists at `packages/server/src/routes/fleets.ts:272`.
- The current create UI only asks for name and wallet count in `packages/web/src/components/ControlsTab.tsx:74`.
- The current fleet trade UI only exposes fleet, coin, amount, slippage, and side in `packages/web/src/components/ControlsTab.tsx:329`.
- There is no sweep UI in the current web surface.
- The current repo status doc calls out sweep, drip, and jiggle as working operator capabilities in `STATUS.md:8`.

## Proposed Solutions

### Option 1: Expand Existing Controls And Fleet Views

**Approach:** Add advanced create/trade/sweep controls to the current `Controls` and `Fleets` tabs.

**Pros:**
- Fits current information architecture
- Lowest UX disruption

**Cons:**
- Risks making `Controls` denser
- Needs careful progressive disclosure

**Effort:** 4-6 hours

**Risk:** Low

---

### Option 2: Fleet Operations Drawer Or Modal

**Approach:** Keep overview pages simple and launch advanced operations from focused drawers or modals per fleet.

**Pros:**
- Better task focus
- Keeps overview screens cleaner

**Cons:**
- More UI state complexity
- Slightly more implementation overhead

**Effort:** 5-7 hours

**Risk:** Medium

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:**
- `packages/server/src/routes/fleets.ts` - existing advanced fleet APIs
- `packages/web/src/components/ControlsTab.tsx` - current simplified controls
- `packages/web/src/components/FleetsTab.tsx` - likely host for sweep or advanced per-fleet actions
- `packages/web/src/api/client.ts` - would need parity helpers

**Related components:**
- Fleet status/detail panels
- Activity/history surfaces to show drip/sweep results clearly

**Database changes (if any):**
- Migration needed? No
- New columns/tables? No

## Resources

- `packages/server/src/routes/fleets.ts`
- `packages/web/src/components/ControlsTab.tsx`
- `packages/web/src/components/FleetsTab.tsx`
- `docs/OPERATIONS.md`
- `STATUS.md`

## Acceptance Criteria

- [ ] Web supports create-with-funding and source-fleet funding
- [ ] Web supports strategy mode selection on create
- [ ] Web supports drip buy/sell controls, including intervals and jiggle options
- [ ] Web supports sweeping to master, another fleet, or an explicit address
- [ ] Operators can see action outcomes clearly in the UI
- [ ] Relevant web client/component tests are added

## Work Log

### 2026-04-18 - Initial Discovery

**By:** Codex

**Actions:**
- Compared `packages/server/src/routes/fleets.ts` against the current controls UI
- Verified advanced fleet capabilities are already documented and implemented
- Confirmed the web currently exposes only the simplified subset

**Learnings:**
- This is a parity issue, not a backend capability gap
- It should stay out of Automation Console v1 to avoid mixing fleet ops scope with automation scope

## Notes

- Progressive disclosure will matter here; the current controls tab is already fairly dense.
