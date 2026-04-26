# Review Context

## Branch Info
- Base: origin/main
- Current: brennanb2025/pr4-agent-dashboard-v2
- Merge base: a04be9766d8ecabe654262fe22c71d8eed6b1cab

## Changed Files Summary
- M  src/main/codex-accounts/runtime-home-service.test.ts
- M  src/main/codex-accounts/service.test.ts
- M  src/renderer/src/App.tsx
- A  src/renderer/src/components/dashboard/AgentDashboard.tsx
- A  src/renderer/src/components/dashboard/DashboardAgentRow.tsx
- A  src/renderer/src/components/dashboard/DashboardFilterBar.tsx
- A  src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx
- A  src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx
- A  src/renderer/src/components/dashboard/useDashboardData.ts
- A  src/renderer/src/components/dashboard/useDashboardFilter.ts
- A  src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- A  src/renderer/src/components/dashboard/useNow.ts
- A  src/renderer/src/components/dashboard/useRetainedAgents.test.ts
- A  src/renderer/src/components/dashboard/useRetainedAgents.ts
- A  src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx
- M  src/renderer/src/components/right-sidebar/index.tsx
- M  src/renderer/src/components/settings/AgentsPane.tsx
- M  src/renderer/src/components/sidebar/AgentStatusHover.tsx
- A  src/renderer/src/store/slices/agent-status-drop.test.ts
- A  src/renderer/src/store/slices/agent-status-freshness-scheduler.ts
- M  src/renderer/src/store/slices/agent-status.test.ts
- M  src/renderer/src/store/slices/agent-status.ts
- M  src/shared/constants.ts
- M  src/shared/types.ts

Totals: 24 files changed, ~3108 insertions, ~337 deletions

## Changed Line Ranges (PR Scope)
<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->
| File | Changed Lines |
|------|---------------|
| src/main/codex-accounts/runtime-home-service.test.ts | 66 |
| src/main/codex-accounts/service.test.ts | 60 |
| src/renderer/src/App.tsx | 3-7, 18, 147-161, 612-631, 896-899 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-329 (new) |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-487 (new) |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-41 (new) |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-149 (new) |
| src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx | 1-17 (new) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-221 (new) |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-172 (new) |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-200 (new) |
| src/renderer/src/components/dashboard/useNow.ts | 1-18 (new) |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | 1-95 (new) |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 1-237 (new) |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | 1-277 (new) |
| src/renderer/src/components/right-sidebar/index.tsx | 9, 25, 116-121, 158-168 |
| src/renderer/src/components/settings/AgentsPane.tsx | 4, 250-255, 258-292 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | Broad rewrite, lines 2-304 |
| src/renderer/src/store/slices/agent-status-drop.test.ts | 1-195 (new) |
| src/renderer/src/store/slices/agent-status-freshness-scheduler.ts | 1-60 (new) |
| src/renderer/src/store/slices/agent-status.test.ts | 257, 266-321, 356 |
| src/renderer/src/store/slices/agent-status.ts | 13, 44-48, 63-78, 88-91, 98-105, 115-116, 122, 222-234, 237, 244, 263, 288, 291-383, 387-401, 403-404, 408-414, 421-444, 452-463, 467-469, 474-487, 492-497, 510-524 |
| src/shared/constants.ts | 148 |
| src/shared/types.ts | 792-793 |

## Review Standards Reference
- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### AI/Agent (store/state for agent dashboard)
- src/renderer/src/store/slices/agent-status.ts
- src/renderer/src/store/slices/agent-status.test.ts
- src/renderer/src/store/slices/agent-status-drop.test.ts
- src/renderer/src/store/slices/agent-status-freshness-scheduler.ts

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

### Utility/Common
- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts
- src/shared/constants.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

## Iteration State
Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
