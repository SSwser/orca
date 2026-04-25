import React, { useCallback, useMemo } from 'react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import { useDashboardData } from '@/components/dashboard/useDashboardData'
import { enrichGroupsWithRetained } from '@/components/dashboard/useRetainedAgents'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'

type AgentStatusHoverProps = {
  worktreeId: string
  children: React.ReactNode
}

// Why: the hovercard must render the exact same information the per-worktree
// dashboard card shows — hook-reported agents plus any retained "done"
// snapshots. Sharing the dashboard's data pipeline (useDashboardData +
// enrichGroupsWithRetained) and row component (DashboardAgentRow) guarantees
// the two surfaces cannot drift. Retention state itself is hoisted into the
// store (see useRetainedAgentsSync wired at App level), so dismissing in the
// hover reflects in the dashboard and vice versa.
const AgentStatusHover = React.memo(function AgentStatusHover({
  worktreeId,
  children
}: AgentStatusHoverProps) {
  const liveGroups = useDashboardData()
  const retained = useAppStore((s) => s.retainedAgentsByPaneKey)
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)

  const agents = useMemo(() => {
    const enriched = enrichGroupsWithRetained(liveGroups, retained)
    for (const group of enriched) {
      for (const wt of group.worktrees) {
        if (wt.worktree.id === worktreeId) {
          return wt.agents
        }
      }
    }
    return []
  }, [liveGroups, retained, worktreeId])

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
