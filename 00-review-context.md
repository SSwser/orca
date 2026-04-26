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
- A src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx
- A src/renderer/src/components/dashboard/useDashboardData.ts
- A src/renderer/src/components/dashboard/useDashboardFilter.ts
- A src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- A src/renderer/src/components/dashboard/useNow.ts
- A src/renderer/src/components/dashboard/useRetainedAgents.test.ts
- A src/renderer/src/components/dashboard/useRetainedAgents.ts
- A src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx
- M src/renderer/src/components/right-sidebar/index.tsx
- M src/renderer/src/components/settings/AgentsPane.tsx
- M src/renderer/src/components/sidebar/AgentStatusHover.tsx
- A src/renderer/src/store/slices/agent-status-drop.test.ts
- M src/renderer/src/store/slices/agent-status.test.ts
- M src/renderer/src/store/slices/agent-status.ts
- M src/shared/constants.ts
- M src/shared/types.ts

## Changed Line Ranges (PR Scope)
<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->
| File | Changed Lines |
|------|---------------|
| src/main/codex-accounts/runtime-home-service.test.ts | 66-66 |
| src/main/codex-accounts/service.test.ts | 60-60 |
| src/renderer/src/App.tsx | 3-7, 18-18, 147-161, 612-620, 885-888 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-330 |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-476 |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-41 |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-144 |
| src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx | 1-17 |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-216 |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-170 |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-200 |
| src/renderer/src/components/dashboard/useNow.ts | 1-18 |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | 1-95 |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 1-229 |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | 1-273 |
| src/renderer/src/components/right-sidebar/index.tsx | 9, 25, 116-121, 158-168 |
| src/renderer/src/components/settings/AgentsPane.tsx | 4, 250-289 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | 5-10, 21-42, 47-53, 78-81, 87-92, 98-176, 180-195, 227-231, 237-299 |
| src/renderer/src/store/slices/agent-status-drop.test.ts | 1-142 |
| src/renderer/src/store/slices/agent-status.test.ts | 257, 300 |
| src/renderer/src/store/slices/agent-status.ts | 43-47, 62-77, 87-90, 155, 255-270, 324-401, 405-415, 425-448, 480-494 |
| src/shared/constants.ts | 148 |
| src/shared/types.ts | 792-793 |

## Review Standards Reference
- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Frontend/UI
- src/renderer/src/App.tsx
- src/renderer/src/components/dashboard/AgentDashboard.tsx
- src/renderer/src/components/dashboard/DashboardAgentRow.tsx
- src/renderer/src/components/dashboard/DashboardFilterBar.tsx
- src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx
- src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx
- src/renderer/src/components/dashboard/useDashboardData.ts
- src/renderer/src/components/dashboard/useDashboardFilter.ts
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- src/renderer/src/components/dashboard/useNow.ts
- src/renderer/src/components/dashboard/useRetainedAgents.ts
- src/renderer/src/components/dashboard/useRetainedAgents.test.ts
- src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx
- src/renderer/src/components/right-sidebar/index.tsx
- src/renderer/src/components/settings/AgentsPane.tsx
- src/renderer/src/components/sidebar/AgentStatusHover.tsx

### Utility/Common (store slices + shared types/constants + test stubs)
- src/renderer/src/store/slices/agent-status.ts
- src/renderer/src/store/slices/agent-status.test.ts
- src/renderer/src/store/slices/agent-status-drop.test.ts
- src/shared/constants.ts
- src/shared/types.ts
- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts

## Skipped Issues (Do Not Re-validate)
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

src/renderer/src/components/dashboard/useDashboardKeyboard.ts:89 | Medium | Theoretical, no realistic bug path | target.isContentEditable cast to HTMLElement
src/renderer/src/components/dashboard/useDashboardKeyboard.ts:167 | Medium | Stylistic shadowing, no bug | target variable shadowed
src/renderer/src/components/dashboard/useDashboardKeyboard.ts:62-76 | Low | Safe idiomatic pattern | useEffect writes to refs
src/renderer/src/components/dashboard/useDashboardKeyboard.ts:105-108 | Low | Cosmetic, no bug | FILTER_KEYS[e.key] double lookup
src/renderer/src/components/dashboard/DashboardAgentRow.tsx:122-126 | Low | False positive | stopKeyDown no preventDefault on Space
src/renderer/src/components/dashboard/DashboardAgentRow.tsx:283-321 | Low | Working as designed (a11y) | X button opacity crossfade focus behavior
src/renderer/src/components/dashboard/DashboardAgentRow.tsx:148 | Low | Correct code | startedAt > 0 ? x : null sentinel
src/renderer/src/components/dashboard/useDashboardData.ts:213-214 | Low | Self-refuting - buildDashboardData already takes now param | eslint-disable-next-line exhaustive-deps
src/renderer/src/components/dashboard/useDashboardData.ts:81-121 + src/renderer/src/components/sidebar/AgentStatusHover.tsx:98-160 | Medium | Structural refactor, consistency now enforced by Finding 1 fix | Duplicated row-building logic
src/renderer/src/components/dashboard/useRetainedAgents.ts:165-168 | Medium | False positive - startedAt in retained is always real timestamp | retained startedAt 0 edge case in Math.min
src/renderer/src/store/slices/agent-status.ts:97-98 | Medium | Structural fix >50 unrelated lines; existing comment warns | staleExpiryTimer no dispose hook
src/renderer/src/store/slices/agent-status.ts:155 | Low | Consumption already invariant; documented | retentionSuppressedPaneKeys orphan concern
src/renderer/src/store/slices/agent-status-drop.test.ts:100-116 | Low | Nice-to-have, not a regression-risk | Missing identity-preservation assertion
src/main/codex-accounts/*.test.ts | Low | Out of scope - test-fixture tech debt | makeDefaultGlobalSettings helper suggestion

## Iteration State
Current iteration: 2
Last completed phase: Iteration 1 complete — 7 files fixed + 1 new helper file (agent-status-freshness-scheduler.ts)
Files fixed this iteration: []

## Previously Fixed (iteration 1)
- DashboardAgentRow.tsx: displayLabel fallback when prompt is empty
- useDashboardData.ts: stateStartedAt fallback instead of updatedAt
- AgentStatusHover.tsx: same stateStartedAt fallback
- agent-status.ts: dismissRetainedAgentsByWorktree now plants suppressors for live-overlapping paneKeys; invariant + no-epoch-bump comments added; freshness scheduler extracted to agent-status-freshness-scheduler.ts
- agent-status.test.ts: added assertion for suppressor contract on bulk dismiss
- App.tsx: Cmd+Shift+D guarded by xterm-helper-textarea focus check
- AgentDashboard.tsx: focus moved from []-deps useEffect into setContainerRef callback
