---
status: pending
priority: p3
issue_id: "003"
tags: [intelligence, automation, roadmap]
dependencies: []
---

# Advance Intelligence Automation Roadmap

Preserve and later break down the unfinished intelligence-driven automation work that remains outside the current v1 scope.

## Problem Statement

The repo still has unfinished roadmap items around alert-driven automation, richer combined status visibility, and exit intelligence. Those items are not part of the current Automation Console v1, but they need to remain durable work items instead of living only in informal memory or a status document.

## Findings

- `STATUS.md:30` lists unfinished roadmap items including alert-to-signal bridge, exit intelligence, and combined intelligence status.
- Alert dispatch already exists on the server at `packages/server/src/routes/intelligence.ts:145`.
- Signal candidate inspection and support-from-signal operation creation already exist at `packages/server/src/routes/operations.ts:211` and `packages/server/src/routes/operations.ts:242`.
- Autonomy currently uses dip/pump heuristics and auto-approval behavior in `packages/server/src/services/autonomy.ts`.
- Intelligence and autonomy are surfaced separately in the current web app, with no combined operator status view.

## Proposed Solutions

### Option 1: Keep As Umbrella Todo Until Post-v1 Triage

**Approach:** Preserve this as one umbrella work item now, then split after Automation Console v1 ships.

**Pros:**
- Fastest capture
- Avoids premature design decisions while the base console is still in progress

**Cons:**
- Less immediately executable
- Future triage will still need a decomposition pass

**Effort:** 1-2 hours later for decomposition

**Risk:** Low

---

### Option 2: Split Immediately Into Multiple Ready-To-Plan Todos

**Approach:** Break into separate items for alert-to-signal bridge, combined status UI, and exit-intelligence policy/UX.

**Pros:**
- Cleaner future execution units
- Easier prioritization

**Cons:**
- More up-front planning work now
- Risks over-specifying before v1 operator workflows settle

**Effort:** 2-3 hours

**Risk:** Medium

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:**
- `STATUS.md` - source of roadmap intent
- `packages/server/src/routes/intelligence.ts` - current alert and intelligence surfaces
- `packages/server/src/routes/operations.ts` - current signal-driven operation surfaces
- `packages/server/src/services/autonomy.ts` - current buy/sell automation logic
- `packages/web/src/components/DashboardTab.tsx` and `packages/web/src/components/IntelligenceTab.tsx` - current split UI surfaces

**Related components:**
- Future automation console
- Intelligence operator views
- Potential swing/autonomy coordination

**Database changes (if any):**
- Migration needed? Unknown
- New columns/tables? To be determined during later planning

## Resources

- `STATUS.md`
- `packages/server/src/routes/intelligence.ts`
- `packages/server/src/routes/operations.ts`
- `packages/server/src/services/autonomy.ts`

## Acceptance Criteria

- [ ] The unfinished roadmap work is preserved durably in the repo todo system
- [ ] Follow-up triage decides whether to split this into smaller implementation items
- [ ] Any future implementation defines operator visibility, approval model, and failure handling before coding starts

## Work Log

### 2026-04-18 - Initial Discovery

**By:** Codex

**Actions:**
- Reviewed repo roadmap and matched it against currently routed server capabilities
- Identified partial building blocks already present for alert dispatch, signal selection, and autonomy status
- Deferred these items intentionally from Automation Console v1 to keep the first pass shippable

**Learnings:**
- These are real roadmap items, but not all of them are implementation-ready yet
- Combined status and alert-driven automation should be revisited after the base automation operator workflows are in place

## Notes

- Exit intelligence should be evaluated alongside the existing swing and autonomy models instead of being designed in isolation.
