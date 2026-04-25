# Review Context

## Branch Info

- Base: origin/main (merge-base: a04be9766d8ecabe654262fe22c71d8eed6b1cab)
- Current: brennanb2025/pr4-agent-dashboard-v2

## Changed Files Summary

| File | Change Type |
| --- | --- |
| src/main/codex-accounts/runtime-home-service.test.ts | M |
| src/main/codex-accounts/service.test.ts | M |
| src/renderer/src/App.tsx | M |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | A |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | A |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | A |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | A |
| src/renderer/src/components/dashboard/useDashboardData.ts | A |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | A |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | A |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | A |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | A |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | A |
| src/renderer/src/components/right-sidebar/index.tsx | M |
| src/renderer/src/components/settings/AgentsPane.tsx | M |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | M |
| src/renderer/src/store/slices/agent-status.ts | M |
| src/shared/constants.ts | M |
| src/shared/types.ts | M |

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File | Changed Lines |
| --- | --- |
| src/main/codex-accounts/runtime-home-service.test.ts | 66 |
| src/main/codex-accounts/service.test.ts | 60 |
| src/renderer/src/App.tsx | 3-7, 18-19, 148-159, 610-617 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-302 (new file) |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-459 (new file) |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-41 (new file) |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-122 (new file) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-164 (new file) |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-134 (new file) |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-145 (new file) |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | 1-95 (new file) |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 1-230 (new file) |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | 1-155 (new file) |
| src/renderer/src/components/right-sidebar/index.tsx | 9, 25, 116-121, 158-168 |
| src/renderer/src/components/settings/AgentsPane.tsx | 4, 252-283 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | 1-100 (major rewrite) |
| src/renderer/src/store/slices/agent-status.ts | 43-47, 62-69, 81-84, 149, 249-253, 256, 310-382, 434-448 |
| src/shared/constants.ts | 148 |
| src/shared/types.ts | 792-793 |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Category 3: Frontend/UI (all files in src/renderer/src/)

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
- src/renderer/src/store/slices/agent-status.ts

### Category 1: Electron/Main (tests in src/main/)

- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts

### Category 5: Utility/Common (shared types/constants)

- src/shared/constants.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

(empty)

## Iteration State

Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
