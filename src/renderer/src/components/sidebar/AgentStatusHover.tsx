import React, { useCallback, useMemo } from 'react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import type { DashboardAgentRow as DashboardAgentRowType } from '@/components/dashboard/useDashboardData'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

type AgentStatusHoverProps = {
  worktreeId: string
  children: React.ReactNode
}

// Why: the hovercard must render the exact same information the per-worktree
// dashboard card shows — hook-reported agents plus any retained "done"
// snapshots. We intentionally do NOT call useDashboardData() +
// enrichGroupsWithRetained() here, even though that would centralize the row-
// building logic. AgentStatusHover wraps every WorktreeCard, so reusing the
// full dashboard pipeline would mean every agent-status event recomputes the
// entire repo × worktree × tabs × agentStatus aggregation once per card on
// screen — O(worktrees²) work per update (render amplification). Instead we
// read the store's primitive maps via narrow selectors and do a focused
// per-worktree scan that mirrors buildAgentRowsForWorktree in
// useDashboardData.ts and the retained-row merge in useRetainedAgents.ts.
// Retention state itself is still hoisted into the store (see
// useRetainedAgentsSync wired at App level), so dismissing in the hover
// reflects in the dashboard and vice versa.
const AgentStatusHover = React.memo(function AgentStatusHover({
  worktreeId,
  children
}: AgentStatusHoverProps) {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId])
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retained = useAppStore((s) => s.retainedAgentsByPaneKey)
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries
  // expire, even if no new PTY data arrives — same rationale as
  // useDashboardData.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)

  const agents = useMemo<DashboardAgentRowType[]>(() => {
    const rows: DashboardAgentRowType[] = []
    const seenPaneKeys = new Set<string>()
    // Why: Date.now() is read inside the memo (not as a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks — same pattern as
    // useDashboardData.
    const now = Date.now()

    // Why: build a tabId -> entries index once instead of re-scanning every
    // agent status entry inside the per-tab loop. paneKey is formatted as
    // `${tabId}:${paneId}`; splitting on the first ':' lets us bucket entries
    // by tab in a single O(N) pass, turning the per-worktree build from
    // O(tabs × statuses) into O(tabs + statuses). Mirrors the same index
    // built in useDashboardData.buildDashboardData.
    const entriesByTabId = new Map<string, AgentStatusEntry[]>()
    for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
      const colonIndex = paneKey.indexOf(':')
      if (colonIndex === -1) {
        continue
      }
      const tabId = paneKey.slice(0, colonIndex)
      const bucket = entriesByTabId.get(tabId)
      if (bucket) {
        bucket.push(entry)
      } else {
        entriesByTabId.set(tabId, [entry])
      }
    }

    // Live rows — mirror buildAgentRowsForWorktree in useDashboardData.ts.
    const worktreeTabs = tabs ?? []
    for (const tab of worktreeTabs) {
      const explicitEntries = entriesByTabId.get(tab.id) ?? []
      for (const entry of explicitEntries) {
        // Why: decay stale working/blocked/waiting entries to 'idle' when the
        // hook stream has gone silent past AGENT_STATUS_STALE_AFTER_MS. Without
        // this, an agent that exited without a final update would keep the
        // hover's "Running agents" count and the dashboard filters inflated
        // with dead work. `done` is terminal and must NOT decay to idle —
        // retention (collectRetainedAgentsOnDisappear) only keeps rows whose
        // prev state was 'done', so a stale done → idle would silently drop
        // the completion signal. Mirrors useDashboardData.buildAgentRowsForWorktree.
        const isFresh = isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
        const shouldDecay =
          !isFresh &&
          (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
        rows.push({
          paneKey: entry.paneKey,
          entry,
          tab,
          agentType: entry.agentType ?? 'unknown',
          state: shouldDecay ? 'idle' : entry.state,
          // Why: the oldest stateHistory entry's startedAt is the agent's
          // original "first seen" timestamp. When history is empty the entry
          // is brand new, so updatedAt is the best start-time approximation
          // available. Matches useDashboardData's semantics exactly.
          startedAt: entry.stateHistory[0]?.startedAt ?? entry.updatedAt
        })
        seenPaneKeys.add(entry.paneKey)
      }
    }

    // Retained rows — mirror enrichGroupsWithRetained: add a retained snapshot
    // only if it belongs to THIS worktree and no live row already occupies its
    // paneKey.
    for (const ra of Object.values(retained)) {
      if (ra.worktreeId !== worktreeId) {
        continue
      }
      if (seenPaneKeys.has(ra.entry.paneKey)) {
        continue
      }
      rows.push({
        paneKey: ra.entry.paneKey,
        entry: ra.entry,
        tab: ra.tab,
        agentType: ra.agentType,
        state: 'done',
        startedAt: ra.startedAt
      })
    }

    // Why: sort oldest-first to match useDashboardData ordering — stable list
    // order keeps new agents from shoving the row the user is reading.
    rows.sort((a, b) => a.startedAt - b.startedAt)
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, agentStatusByPaneKey, retained, worktreeId, agentStatusEpoch])

  // Why: mirror AgentDashboard.handleDismissAgent so dismissing in either
  // surface has identical effect — removes the live store entry and the
  // retained snapshot if either is present.
  const handleDismissAgent = useCallback(
    (paneKey: string) => {
      dropAgentStatus(paneKey)
      dismissRetainedAgent(paneKey)
    },
    [dropAgentStatus, dismissRetainedAgent]
  )

  // Why: clicking a row activates the specific tab the agent runs in. Retained
  // rows can outlive their tab, so fall back to worktree-only activation when
  // the tab is no longer present.
  const handleActivateAgentTab = useCallback(
    (tabId: string) => {
      setActiveWorktree(worktreeId)
      setActiveView('terminal')
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId)
      }
    },
    [worktreeId, setActiveWorktree, setActiveTab, setActiveView]
  )

  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {/* Why: the shared HoverCard uses `border-border/50`, but `--border`
          already carries very different alpha per theme (#e5e5e5 opaque in
          light, rgb(255 255 255 / 0.07) in dark). At /50 the dark-mode edge
          collapses to ~3% alpha and the card looks borderless. Override to
          explicit light/dark tokens so the card outline reads the same in
          both modes. */}
      <HoverCardContent
        side="right"
        align="start"
        className="w-72 border-neutral-200 bg-popover p-3 text-xs dark:border-white/10"
      >
        {agents.length === 0 ? (
          <div className="py-1 text-center text-muted-foreground">No running agents</div>
        ) : (
          <div className="flex flex-col">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Running agents ({agents.length})
            </div>
            {/* Why: same reason as the card border above — `divide-border/60`
                on dark `--border` (0.07 alpha) evaluates to ~4% alpha and
                the row separators disappear. Pin explicit light/dark tokens
                so the dividers stay legible in either mode. */}
            <div className="flex flex-col divide-y divide-neutral-200 dark:divide-white/10">
              {agents.map((agent) => (
                <div key={agent.paneKey} className="py-1">
                  <DashboardAgentRow
                    agent={agent}
                    onDismiss={handleDismissAgent}
                    onActivate={handleActivateAgentTab}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
})

export default AgentStatusHover
