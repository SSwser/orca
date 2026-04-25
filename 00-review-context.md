# Review Context

## Branch Info

- Base: origin/main
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
- M src/renderer/src/store/slices/agent-status.ts
- M src/shared/constants.ts
- M src/shared/types.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File | Changed Lines |
| ---- | ------------- |
| src/main/codex-accounts/runtime-home-service.test.ts | 66 |
| src/main/codex-accounts/service.test.ts | 60 |
| src/renderer/src/App.tsx | 3-7, 18-19, 148-159, 610-617 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-308 (new file) |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-474 (new file) |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-41 (new file) |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-122 (new file) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-198 (new file) |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-130 (new file) |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-145 (new file) |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | 1-95 (new file) |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 1-224 (new file) |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | 1-164 (new file) |
| src/renderer/src/components/right-sidebar/index.tsx | 9, 25, 116-121, 158-168 |
| src/renderer/src/components/settings/AgentsPane.tsx | 4, 252-283 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | 4-7, 14-27, 32-38, 40, 46-51, 54-86, 90-94, 97-106, 110-125, 157, 162, 169-172 |
| src/renderer/src/store/slices/agent-status.ts | 43-47, 62-69, 81-84, 149, 249-253, 256, 310-382, 434-448 |
| src/shared/constants.ts | 148 |
| src/shared/types.ts | 792-793 |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Category 3: Frontend/UI (primary category for most files)

- src/renderer/src/App.tsx
- src/renderer/src/components/dashboard/AgentDashboard.tsx
- src/renderer/src/components/dashboard/DashboardAgentRow.tsx
- src/renderer/src/components/dashboard/DashboardFilterBar.tsx
- src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx
- src/renderer/src/components/dashboard/useDashboardData.ts
- src/renderer/src/components/dashboard/useDashboardFilter.ts
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- src/renderer/src/components/dashboard/useRetainedAgents.ts
- src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx
- src/renderer/src/components/right-sidebar/index.tsx
- src/renderer/src/components/settings/AgentsPane.tsx
- src/renderer/src/components/sidebar/AgentStatusHover.tsx
- src/renderer/src/store/slices/agent-status.ts

### Category 5: Utility/Common

- src/renderer/src/components/dashboard/useRetainedAgents.test.ts
- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts
- src/shared/constants.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []

## Skipped Issues (Do Not Re-validate)

- src/main/codex-accounts/runtime-home-service.test.ts:66 | Low | Low-value test coverage gap note (non-actionable in this file) | No-op
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts:129 (containerRef in deps) | Low | containerRef is stable - this is a stylistic lint preference; removing it risks ESLint exhaustive-deps warnings | Minor style
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts:67-69 (FILTER_KEYS double lookup) | Low | Cosmetic micro-optimization; object lookup is O(1) | Cosmetic
- src/renderer/src/components/dashboard/useRetainedAgents.test.ts (test coverage gaps) | Low | Added tests would be nice-to-have but don't guard a regression path; the code logic is already thoroughly commented | Coverage
- src/renderer/src/components/dashboard/DashboardAgentRow.tsx:465-469 (canExpand edge case) | Low | Current behavior is acceptable per comments — prompt alone triggering chevron is reasonable | Intentional
- src/renderer/src/components/dashboard/AgentDashboard.tsx:110-114 (ESLint suppression) | Low | Only matters if lint rules change; refs are stable | Style
- src/renderer/src/App.tsx:155-159 (conditional hook guard) | Low | AGENT_DASHBOARD_ENABLED is a hard-coded const; eslint-disable is already explicit. Per the comment, this entire block goes away when the flag flips | Intentional, flagged
- src/shared/constants.ts:148 field ordering | Low | Purely cosmetic; doesn't affect runtime | Cosmetic
- src/renderer/src/components/right-sidebar/index.tsx:121 (!== false pattern) | Low | Field is required boolean; the pattern is intentional per comment for load-time | Intentional
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts listener churn (high-churn attach/detach) | Low | Works correctly; optimization would require ref-based handler pattern refactor. Not blocking | Perf micro-opt
- src/renderer/src/components/dashboard/useDashboardData.ts:163 (sentinel 0 for earliestStartedAt) | Low | Empty-agents worktrees are filtered out before sort; changing to POSITIVE_INFINITY is defensive but current invariant is enforced | Defensive only
- src/renderer/src/components/dashboard/useRetainedAgents.ts:37-38 (stale suppressor GC) | Low | Covered by explicit-teardown flow; stale suppressors only on retained-only dismiss which is rare; memory leak is bounded by paneKey count | Low-impact
- src/renderer/src/components/dashboard/useDashboardFilter.ts:97 (earliestStartedAt not recomputed after filter) | Low | Intentional: "stability while reading" design. Already documented elsewhere. Would flip behavior if changed | Intentional
- src/renderer/src/components/dashboard/useRetainedAgents.ts:75-80 (unnecessary useCallback) | Low | Defensive — shields against future upstream ref instability. Removal is purely stylistic | Cosmetic
- src/renderer/src/components/sidebar/AgentStatusHover.tsx:32,135 variable shadowing | Low | Readability nit; the local shadow is intentional (reads latest store state at click time) | Cosmetic
