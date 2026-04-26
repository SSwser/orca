# Review Context

## Branch Info

- Base: origin/main (a04be9766d8ecabe654262fe22c71d8eed6b1cab)
- Current: brennanb2025/pr4-agent-dashboard-v2

## Changed Files Summary

- M src/main/codex-accounts/runtime-home-service.test.ts
- M src/main/codex-accounts/service.test.ts
- M src/renderer/src/App.tsx
- A src/renderer/src/components/dashboard/AgentDashboard.tsx
- A src/renderer/src/components/dashboard/DashboardAgentRow.tsx
- A src/renderer/src/components/dashboard/DashboardFilterBar.tsx
- A src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx
- A src/renderer/src/components/dashboard/useDashboardData.ts
- A src/renderer/src/components/dashboard/useDashboardFilter.ts
- A src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- A src/renderer/src/components/dashboard/useRetainedAgents.test.ts
- A src/renderer/src/components/dashboard/useRetainedAgents.ts
- A src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx
- M src/renderer/src/components/right-sidebar/index.tsx
- M src/renderer/src/components/settings/AgentsPane.tsx
- M src/renderer/src/components/sidebar/AgentStatusHover.tsx
- M src/renderer/src/store/slices/agent-status.test.ts
- M src/renderer/src/store/slices/agent-status.ts
- M src/shared/constants.ts
- M src/shared/types.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File | Changed Lines |
| --- | --- |
| src/main/codex-accounts/runtime-home-service.test.ts | 66 |
| src/main/codex-accounts/service.test.ts | 60 |
| src/renderer/src/App.tsx | 3-7, 18-19, 148-159, 610-618 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-308 (new) |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-474 (new) |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-41 (new) |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-122 (new) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-201 (new) |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-130 (new) |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-150 (new) |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | 1-95 (new) |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 1-207 (new) |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | 1-170 (new) |
| src/renderer/src/components/right-sidebar/index.tsx | 9, 25, 116-121, 158-168 |
| src/renderer/src/components/settings/AgentsPane.tsx | 4, 250-255, 258-289 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | many (major rewrite — see diff) |
| src/renderer/src/store/slices/agent-status.test.ts | 257, 300 |
| src/renderer/src/store/slices/agent-status.ts | 43-47, 62-74, 84-87, 152, 252-256, 259, 313-397, 401-408, 410-411, 453-467 |
| src/shared/constants.ts | 148 |
| src/shared/types.ts | 792-793 |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main (2 files)
- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts

### Frontend/UI (16 files)
- src/renderer/src/App.tsx
- src/renderer/src/components/dashboard/AgentDashboard.tsx
- src/renderer/src/components/dashboard/DashboardAgentRow.tsx
- src/renderer/src/components/dashboard/DashboardFilterBar.tsx
- src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx
- src/renderer/src/components/dashboard/useDashboardData.ts
- src/renderer/src/components/dashboard/useDashboardFilter.ts
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- src/renderer/src/components/dashboard/useRetainedAgents.test.ts
- src/renderer/src/components/dashboard/useRetainedAgents.ts
- src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx
- src/renderer/src/components/right-sidebar/index.tsx
- src/renderer/src/components/settings/AgentsPane.tsx
- src/renderer/src/components/sidebar/AgentStatusHover.tsx
- src/renderer/src/store/slices/agent-status.test.ts
- src/renderer/src/store/slices/agent-status.ts

### Utility/Common (2 files)
- src/shared/constants.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

- [src/renderer/src/components/dashboard/DashboardAgentRow.tsx:174-347] | Low | requires architecture-level refactor >50 lines, author intentionally designed with explicit stop-propagation handling, functional behavior works | Nested interactive elements (role="button" div containing nested <button>s) — a11y pattern.
- [src/renderer/src/components/sidebar/AgentStatusHover.tsx:46] | Low | purely cosmetic consistency; `tabs ?? []` fallback at the call site is already present, no correctness impact | tabs selector missing EMPTY_TABS module-scoped fallback.
- [src/renderer/src/components/dashboard/AgentDashboard.tsx:172-185] | Low | minor perf — recompute per-render O(agents) is fine at current scale, moving counts into useDashboardFilter requires threading a new FilteredDashboardGroup field | per-repo rollup counts recomputed inside render.
- [src/renderer/src/components/dashboard/useDashboardKeyboard.ts:40-149] | Low | minor perf — element-level listener churn per PTY tick is cheap; ref-based refactor requires >50 lines of indirection | listener re-attaches on every dashboard data tick.
- [src/renderer/src/components/sidebar/AgentStatusHover.tsx:53-85] | Medium | architectural refactor (materialize bucketed index across store) >50 lines, current narrow selectors already solve the primary re-render concern documented in the comments | O(W·E) scan per store update.
- [src/renderer/src/components/dashboard/useRetainedAgents.ts:107-114] | Low | already guarded by early-return when retainedList is empty; remaining scan is O(total agents) only when retention is active | livePaneKeys construction on every enrichment.
- [src/renderer/src/store/slices/agent-status.ts:355-395] | Low | dead code — will be removed by fix #2 (dropAgentStatusByTabPrefix has no call sites), so scan-fusion is moot | two separate Object.keys scans.
- [src/renderer/src/components/dashboard/useDashboardFilter.ts:78-117] | Low | performance optimization at scale; acceptable at current worktree/agent counts, and `q` is already hoisted before the loop | re-filter on every keystroke without debounce.

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []

## Validated Fixes (Iteration 1)

1. **src/renderer/src/store/slices/agent-status.ts** (dropAgentStatus suppressor leak + dead code removal)
   - Line 313-353 `dropAgentStatus` adds a retention suppressor entry even when the paneKey is retained-only (not live). Retained-only paneKeys never flow through `collectRetainedAgentsOnDisappear` (which only iterates `previousAgents`), so the suppressor entry leaks and only clears if the same paneKey later goes live via `setAgentStatus`. Severity: Medium (Claude + Codex). Fix: only add suppression when `hasLive` is true (live agent being torn down).
   - Line 68, 355-395 `dropAgentStatusByTabPrefix` is declared and implemented but never called in the codebase. Severity: Low (Claude). Fix: remove the declaration and implementation.

2. **src/renderer/src/components/dashboard/useDashboardFilter.ts** (stale earliestStartedAt after filtering)
   - Line 97 — when filter removes the earliest agent, the `{...wt, agents}` spread keeps the original `earliestStartedAt` and the worktree sorts by a stale value. Severity: Low (Claude). Fix: recompute `earliestStartedAt` as the minimum `startedAt` in the filtered agents (with positive-value guard).

3. **src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx** (unclamped persisted height)
   - Line 24-28 — `loadPersistedState` accepts any number including NaN/negative/extreme values, which can break layout on load. Severity: Low-Medium (Claude + Codex). Fix: validate `Number.isFinite(parsed.height)` and clamp to `MIN_HEIGHT` minimum.

4. **src/renderer/src/App.tsx** (conditional hook calls)
   - Line 155-159 — `useDashboardData()` and `useRetainedAgentsSync(...)` are gated on `AGENT_DASHBOARD_ENABLED` with two `eslint-disable react-hooks/rules-of-hooks` suppressions. The existing pattern in the codebase (see WorktreeList.tsx:551, visible-worktrees.ts:123) always calls the hooks and no-ops the internals when the flag is off. Severity: Low (Claude). Fix: always call the hooks; have them short-circuit internally.

5. **src/renderer/src/components/dashboard/DashboardAgentRow.tsx** (N setIntervals)
   - Line 69-85 — each DashboardAgentRow owns its own 30s `setInterval`. With N rows on screen, N timers independently tick and cause N separate re-render commits. Severity: Medium (Claude). Fix: hoist `useNow` into the two callers that own collections of rows (AgentDashboard.tsx, AgentStatusHover.tsx) and pass `now` as a prop into DashboardAgentRow. Collapses N intervals → 1 per surface, and the passed `now` is memoized at the parent level.
