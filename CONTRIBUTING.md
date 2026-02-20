# Contributing — Git & Code Standards

## Commit Hygiene

### Conventional Commits (required)

```
<type>(<scope>): <short summary>

<optional body>
```

**Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `perf`

**Scope** (optional): module or subsystem — `quoter`, `fleet`, `poolDiscovery`, `cdp`, `monitor`, etc.

### One Concern Per Commit

Each commit must address **one** logical change. Ask yourself: "Can I describe this commit without using 'and'?" If not, split it.

**Good:**
```
feat(quoter): add sequential single-hop quoting fallback
fix(fleet): pre-validate funding balance before wallet creation
test(drip): add schedule builder unit tests
```

**Bad:**
```
feat: sell path with Permit2, pool discovery, mainnet e2e buy+sell
fix: three critical issues for live fleet operation
```

### Size Limits

- Aim for **<300 lines changed** per commit (excluding generated files)
- If a feature requires more, break it into incremental commits:
  1. Add the new module with tests
  2. Wire it into existing code
  3. Update routes/API surface

### Commit Body

For non-trivial changes, explain **why** in the body:
```
fix(fleet): pre-validate funding balance before wallet creation

createFleet was starting transfers before confirming the funding source
had enough ETH. This could leave fleets in a partially-funded state
with no recovery path. Now checks balance (transfers + gas estimate)
and returns funding address + deficit if insufficient.
```

## Branching

- **`main`** is the stable branch — should always pass tests
- Use feature branches for multi-commit work: `feat/momentum-intelligence`, `fix/doppler-quoting`
- Squash-merge or rebase onto main — no merge commits
- Delete branches after merge

## Code Standards

- **TypeScript strict mode, ESM**
- **No `as any`** — use minimal structural interfaces or `satisfies`
- **Pure viem** — no Uniswap SDK dependencies
- **Tests are mandatory** — every new module gets unit tests; behavior changes update existing tests
- Run `yarn test` before committing — all tests must pass

## PR Checklist (when applicable)

- [ ] Conventional commit messages
- [ ] One concern per commit
- [ ] Tests added/updated
- [ ] `yarn test` passes
- [ ] No `as any`
- [ ] No secrets in committed files
