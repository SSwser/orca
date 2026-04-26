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

src/renderer/src/components/dashboard/useDashboardData.ts:197-220 | Medium | Epoch mechanism verifiably sound; threading `now` would either undo RetainedAgentsSyncGate isolation or reintroduce same Date.now fallback. Existing comments document the coupling. | Hidden Date.now() in useMemo
src/renderer/src/components/dashboard/useRetainedAgents.ts:56-76 | Low | Existing comments already adequate | Snapshot semantics documentation
src/renderer/src/components/dashboard/useRetainedAgents.ts:173-176 | Low | False positive — upstream length guard already protects spread | Filter guard order (retainedForWt)
src/renderer/src/components/dashboard/useDashboardKeyboard.ts:53 | Low | React setState setter identity is stable; existing comment documents pattern | setContainerEl as callback ref
src/renderer/src/components/dashboard/useNow.ts:14 | Low | 30s tick is negligible; visibility listener is new feature not bug fix | useNow visibility pause
src/renderer/src/components/dashboard/useDashboardFilter.ts:63-77 | Low | Short-string micro-opt; already memoized on searchQuery | Lowercasing each candidate
src/renderer/src/components/dashboard/DashboardFilterBar.tsx:22-27 | Low | ToggleGroup re-renders on value change anyway; purely cosmetic perf | Inline handler vs memo
src/renderer/src/components/sidebar/AgentStatusHover.tsx:76-86 | Low | Current narrow selector is already the explicitly-justified optimization; store-level refactor out of scope | Per-card Object.values scan
src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx:117-125 | Medium | Micro-optimization; React 18 batches, rows memoized, only wrapper re-renders; would add rAF cancel complexity | setHeight on every mousemove
src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx:101-115 | Low | Intentional design to avoid losing last drag in debounce window; thrash risk theoretical | Unmount flush localStorage
src/renderer/src/components/dashboard/AgentDashboard.tsx:173 | Low | Parent re-renders per keystroke anyway; Input not memoized | Inline onChange
src/renderer/src/store/slices/agent-status.ts:296-299 | Low | False positive — zustand set() is synchronous by documented API contract; alternative is strictly worse | liveExisted mutated from reducer
src/renderer/src/App.tsx:896-899 | Low | False positive — both hooks early-return on !AGENT_DASHBOARD_ENABLED as documented | RetainedAgentsSyncGate flag gating

## Iteration State
Current iteration: 3
Last completed phase: Phase 3 validation + partial inline fixes from validation agents
Files fixed in prior phase: useDashboardKeyboard.ts, AgentDashboard.tsx, agent-status.ts, agent-status-freshness-scheduler.ts, types.ts
Remaining to fix: DashboardAgentRow.tsx, DashboardWorktreeCard.tsx, useRetainedAgents.ts, DashboardBottomPanel.tsx
