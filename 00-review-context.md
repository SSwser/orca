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

Total: 23 files changed, 2683 insertions(+), 288 deletions(-)

## Changed Line Ranges (PR Scope)
<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->
| File | Changed Lines |
|------|---------------|
| src/main/codex-accounts/runtime-home-service.test.ts | 66 |
| src/main/codex-accounts/service.test.ts | 60 |
| src/renderer/src/App.tsx | 3-7, 18, 147-161, 612-620, 885-888 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-311 (all new) |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-476 (all new) |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-41 (all new) |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-144 (all new) |
| src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx | 1-17 (all new) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-216 (all new) |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-170 (all new) |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-176 (all new) |
| src/renderer/src/components/dashboard/useNow.ts | 1-18 (all new) |
| src/renderer/src/components/dashboard/useRetainedAgents.test.ts | 1-95 (all new) |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 1-229 (all new) |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | 1-230 (all new) |
| src/renderer/src/components/right-sidebar/index.tsx | 9, 25, 116-121, 158-168 |
| src/renderer/src/components/settings/AgentsPane.tsx | 4, 250-255, 258-289 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | 1-300 (large rewrite, most of file) |
| src/renderer/src/store/slices/agent-status-drop.test.ts | 1-142 (all new) |
| src/renderer/src/store/slices/agent-status.test.ts | 257, 300 |
| src/renderer/src/store/slices/agent-status.ts | 43-47, 62-77, 87-90, 155, 255-267, 270, 324-386, 390-397, 399-400, 442-456 |
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

### Backend/API
- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts

### Utility/Common (state management/shared types)
- src/renderer/src/store/slices/agent-status.ts
- src/renderer/src/store/slices/agent-status.test.ts
- src/renderer/src/store/slices/agent-status-drop.test.ts
- src/shared/constants.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)
<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx:123-137 | Medium | Defensive doc only - handlers stable by construction | Drag teardown fragility against future edits
src/renderer/src/components/dashboard/useDashboardKeyboard.ts:46-54 | Low | Cosmetic perf polish - 3 ref writes per render is negligible | Ref-sync effects lack dep arrays
src/renderer/src/components/dashboard/DashboardAgentRow.tsx:178-181 | Medium | Requires composite-widget refactor - out of scope for review-fix | role=button nested interactive elements
src/renderer/src/components/dashboard/DashboardAgentRow.tsx:229-257 | Low | Electron/Chromium-only is fine - already documented | interpolate-size CSS Chromium-only
src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx:84-90 | Medium | Requires composite-widget refactor - out of scope | role=button nested interactive elements
src/renderer/src/components/dashboard/useDashboardData.ts:192-215 | Medium | Structural perf concern - deferred per reviewer guidance | Memo recomputes on every PTY event
src/renderer/src/components/dashboard/useDashboardData.ts:150-178 | Low | Structural per-worktree cache - non-trivial refactor | repos.map creates new refs, breaks React.memo
src/renderer/src/components/dashboard/useRetainedAgents.ts:44-55 | Medium | Structural concern - current behavior is safe | Effect only observes suppressor on liveGroups change
src/renderer/src/components/dashboard/useRetainedAgents.ts:165-168 | Low | Guarded defensively - no actual bug | POSITIVE_INFINITY fallback unreachable
src/renderer/src/components/dashboard/useRetainedAgents.ts:150 | Low | Safe by construction - tab IDs unique | Cross-worktree paneKey collision theoretical only
src/renderer/src/components/dashboard/AgentDashboard.tsx:124 | Low | Current behavior is intentional per comment | document.activeElement check
src/renderer/src/components/dashboard/AgentDashboard.tsx:87-97 | Low | Existing comment sufficient | Optional comment request
src/renderer/src/components/sidebar/AgentStatusHover.tsx:47 | Low | Not confirmed without profiling | Possible render amplification
src/renderer/src/components/sidebar/AgentStatusHover.tsx:114-127 | Low | Style choice only | Minor inefficiency in entriesByTabId
src/renderer/src/components/right-sidebar/index.tsx:168 | Low | Intentional product decision | Brief dashboard flash on launch
src/renderer/src/components/settings/AgentsPane.tsx:273 | Low | Already fine | Toggle switch a11y
src/renderer/src/store/slices/agent-status.test.ts:257,300 | Low | False positive - retainAgents does not schedule timers | Missing vi.useFakeTimers()
src/shared/types.ts:792-793 | Low | Comments document defense rationale | showAgentDashboard type/consumer inconsistency

## Iteration State
Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
