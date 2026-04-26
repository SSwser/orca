# Review Context

## Branch Info
- Base: origin/main (merge base: a04be9766d8ecabe654262fe22c71d8eed6b1cab)
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
- A src/renderer/src/store/slices/agent-status-freshness-scheduler.ts
- M src/renderer/src/store/slices/agent-status.test.ts
- M src/renderer/src/store/slices/agent-status.ts
- M src/shared/constants.ts
- M src/shared/types.ts

## Changed Line Ranges (PR Scope)
<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->
| File | Changed Lines |
|------|---------------|
| src/main/codex-accounts/runtime-home-service.test.ts | 66 |
| src/main/codex-accounts/service.test.ts | 60 |
| src/renderer/src/App.tsx | 3-7, 18, 147-161, 612-631, 896-899 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-329 (entire new file) |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-485 (entire new file) |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-41 (entire new file) |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-144 (entire new file) |
| src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx | 1-17 (entire new file) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-221 (entire new file) |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-170 (entire new file) |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-200 (entire new file) |
| src/renderer/src/components/dashboard/useNow.ts | 1-18 (entire new file) |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | 1-95 (entire new file) |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 1-229 (entire new file) |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | 1-273 (entire new file) |
| src/renderer/src/components/right-sidebar/index.tsx | 9, 25, 116-121, 158-168 |
| src/renderer/src/components/settings/AgentsPane.tsx | 4, 250-289 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | 1-305 (major rewrite, entire file in scope) |
| src/renderer/src/store/slices/agent-status-drop.test.ts | 1-142 (entire new file) |
| src/renderer/src/store/slices/agent-status-freshness-scheduler.ts | 1-61 (entire new file) |
| src/renderer/src/store/slices/agent-status.test.ts | 257, 266-321, 356 |
| src/renderer/src/store/slices/agent-status.ts | 13, 44-48, 63-78, 88-91, 98-100, 110-111, 117, 217-229, 232, 239, 258, 283-286, 286-498 (substantial rewrite) |
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
- src/renderer/src/components/dashboard/useRetainedAgents.test.ts
- src/renderer/src/components/dashboard/useRetainedAgents.ts
- src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx
- src/renderer/src/components/right-sidebar/index.tsx
- src/renderer/src/components/settings/AgentsPane.tsx
- src/renderer/src/components/sidebar/AgentStatusHover.tsx

### Utility/Common (store + shared + main tests)
- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts
- src/renderer/src/store/slices/agent-status-drop.test.ts
- src/renderer/src/store/slices/agent-status-freshness-scheduler.ts
- src/renderer/src/store/slices/agent-status.test.ts
- src/renderer/src/store/slices/agent-status.ts
- src/shared/constants.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

(empty)

## Iteration State
Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
