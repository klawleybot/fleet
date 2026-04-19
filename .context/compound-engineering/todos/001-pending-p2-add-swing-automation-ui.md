---
status: pending
priority: p2
issue_id: "001"
tags: [web, automation, swing]
dependencies: []
---

# Add Swing Automation UI

Expose the existing swing automation backend in the web operator console.

## Problem Statement

The backend already supports swing automation configuration and loop control, but there is no web UI for operators to inspect or manage it. That makes the feature effectively hidden unless someone knows the server routes or works directly in code.

## Findings

- The server mounts the swing routes at `packages/server/src/index.ts:95`.
- Swing CRUD and loop control already exist in `packages/server/src/routes/swing.ts`.
- The core swing evaluation and sell execution flow exists in `packages/server/src/services/swing.ts`.
- The web app only exposes `Dashboard`, `Fleets`, `Positions`, `Activity`, `Controls`, and `Intel` in `packages/web/src/App.tsx`.
- No web client helpers, hooks, or components reference `/swing`.

## Proposed Solutions

### Option 1: Dedicated Swing Tab

**Approach:** Add a top-level `Swing` tab with config management and loop status.

**Pros:**
- Clear discoverability
- Keeps swing concerns isolated

**Cons:**
- Adds another top-level navigation item
- Splits automation controls across multiple areas

**Effort:** 4-6 hours

**Risk:** Low

---

### Option 2: Swing Subview Inside Automation Console

**Approach:** Add swing management as a fourth subview inside the broader automation area.

**Pros:**
- Keeps all operator automation controls together
- Reuses the same queue/status mental model

**Cons:**
- Slightly denser automation surface
- Depends on the automation console existing first

**Effort:** 3-5 hours

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:**
- `packages/server/src/index.ts:95` - swing router is mounted
- `packages/server/src/routes/swing.ts` - available REST surface
- `packages/server/src/services/swing.ts` - status, tick, evaluation, and sell logic
- `packages/web/src/App.tsx` - no current UI entry point

**Related components:**
- Future automation console work should likely host this feature
- Queue/history views may need to show swing-generated outcomes

**Database changes (if any):**
- Migration needed? No
- New columns/tables? No; existing `swing_configs` table already exists

## Resources

- `packages/server/src/routes/swing.ts`
- `packages/server/src/services/swing.ts`
- `packages/web/src/App.tsx`

## Acceptance Criteria

- [ ] Web operators can view existing swing configs
- [ ] Web operators can create, edit, enable/disable, and delete swing configs
- [ ] Web operators can start, stop, and manually tick the swing loop
- [ ] Web operators can inspect swing status and last tick results
- [ ] Relevant web client/component tests are added

## Work Log

### 2026-04-18 - Initial Discovery

**By:** Codex

**Actions:**
- Audited the server routes and confirmed `/swing` is fully mounted
- Verified config CRUD and loop control already exist on the backend
- Verified there is currently no web client or component usage for swing automation

**Learnings:**
- This is a clear backend-complete / UI-missing gap
- The likely home for this work is a broader automation console, not a separate ad hoc surface

## Notes

- This was intentionally deferred from Automation Console v1 to keep the first operator surface focused.
