import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import type {
  DashboardRepoGroup,
  DashboardAgentRow,
  DashboardWorktreeCard
} from './useDashboardData'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'

// Why: when an agent finishes or its terminal closes, the store cleans up the
// explicit status entry and the agent vanishes from useDashboardData. Retaining
// the last-known "done" snapshot in the store (not in component state) lets the
// dashboard AND the sidebar hovercard render the exact same set of rows — the
// two surfaces must be consistent so the user sees the same completion in both
// places, and dismissal in one reflects in the other.

export function useRetainedAgentsSync(liveGroups: DashboardRepoGroup[]): void {
  const retainAgent = useAppStore((s) => s.retainAgent)
  const pruneRetainedAgents = useAppStore((s) => s.pruneRetainedAgents)
  const clearRetentionSuppressedPaneKeys = useAppStore((s) => s.clearRetentionSuppressedPaneKeys)
  const prevAgentsRef = useRef<Map<string, { row: DashboardAgentRow; worktreeId: string }>>(
    new Map()
  )

  useEffect(() => {
    const current = new Map<string, { row: DashboardAgentRow; worktreeId: string }>()
    const existingWorktreeIds = new Set<string>()
    for (const group of liveGroups) {
      for (const wt of group.worktrees) {
        existingWorktreeIds.add(wt.worktree.id)
        for (const agent of wt.agents) {
          current.set(agent.paneKey, { row: agent, worktreeId: wt.worktree.id })
        }
      }
    }

    const { retainedAgentsByPaneKey: retainedNow, retentionSuppressedPaneKeys } =
      useAppStore.getState()
    const { toRetain, consumedSuppressedPaneKeys } = collectRetainedAgentsOnDisappear({
      previousAgents: prevAgentsRef.current,
      currentAgents: current,
      retainedAgentsByPaneKey: retainedNow,
      retentionSuppressedPaneKeys
    })
    for (const retained of toRetain) {
      retainAgent(retained)
    }

    prevAgentsRef.current = current
    pruneRetainedAgents(existingWorktreeIds)
    if (consumedSuppressedPaneKeys.length > 0) {
      clearRetentionSuppressedPaneKeys(consumedSuppressedPaneKeys)
    }
  }, [liveGroups, retainAgent, pruneRetainedAgents, clearRetentionSuppressedPaneKeys])
}

export function useRetainedAgents(liveGroups: DashboardRepoGroup[]): {
  enrichedGroups: DashboardRepoGroup[]
  dismissAgent: (paneKey: string) => void
} {
  // Why: the retention sync runs at App level (see useRetainedAgentsSync in
  // App.tsx) so retained entries persist across dashboard mounts. This hook
  // only reads + dismisses individual rows; bulk worktree-level dismissal
  // was removed because silently dropping retained done agents when the
  // user clicks a worktree can erase completion signals for other agents
  // (e.g. a done Codex row while a live Claude row triggered the click).
  const retained = useAppStore((s) => s.retainedAgentsByPaneKey)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)

  const enrichedGroups = useMemo(
    () => enrichGroupsWithRetained(liveGroups, retained),
    [liveGroups, retained]
  )

  const dismissAgent = useCallback(
    (paneKey: string) => {
      dismissRetainedAgent(paneKey)
    },
    [dismissRetainedAgent]
  )

  return { enrichedGroups, dismissAgent }
}

export function enrichGroupsWithRetained(
  liveGroups: DashboardRepoGroup[],
  retained: Record<string, RetainedAgentEntry>
): DashboardRepoGroup[] {
  const retainedList = Object.values(retained)
  if (retainedList.length === 0) {
    return liveGroups
  }

  const byWorktree = new Map<string, RetainedAgentEntry[]>()
  for (const ra of retainedList) {
    const list = byWorktree.get(ra.worktreeId) ?? []
    list.push(ra)
    byWorktree.set(ra.worktreeId, list)
  }

  // Why: if the same paneKey is both live and retained during a render seam,
  // the live row wins so we never double-render an agent mid-transition.
  const livePaneKeys = new Set<string>()
  for (const group of liveGroups) {
    for (const wt of group.worktrees) {
      for (const agent of wt.agents) {
        livePaneKeys.add(agent.paneKey)
      }
    }
  }

  return liveGroups.map((group) => {
    const worktrees = group.worktrees.map((wt) => {
      const retainedForWt = byWorktree
        .get(wt.worktree.id)
        ?.filter((ra) => !livePaneKeys.has(ra.entry.paneKey))
      if (!retainedForWt?.length) {
        return wt
      }

      const retainedRows: DashboardAgentRow[] = retainedForWt.map(retainedToRow)

      // Why: re-sort after merging retained rows ascending by startedAt so
      // the list order matches useDashboardData (oldest first, new rows
      // append at the bottom) and doesn't reshuffle rows the user is
      // currently reading.
      const mergedAgents = [...wt.agents, ...retainedRows].sort((a, b) => a.startedAt - b.startedAt)
      return {
        ...wt,
        agents: mergedAgents,
        dominantState: computeDominant(mergedAgents),
        // Why: earliestStartedAt should anchor to the oldest start across live
        // and retained rows — retained entries can be *older* than current
        // live agents (they're what's lingering from a prior run), so the
        // min keeps the worktree's list position stable as retained rows
        // merge in.
        earliestStartedAt: Math.min(
          wt.earliestStartedAt > 0 ? wt.earliestStartedAt : Number.POSITIVE_INFINITY,
          ...retainedForWt.map((ra) => ra.startedAt)
        )
      } satisfies DashboardWorktreeCard
    })

    const attentionCount = worktrees.reduce(
      (count, wt) =>
        count + wt.agents.filter((a) => a.state === 'blocked' || a.state === 'waiting').length,
      0
    )

    return { ...group, worktrees, attentionCount } satisfies DashboardRepoGroup
  })
}

function retainedToRow(ra: RetainedAgentEntry): DashboardAgentRow {
  return {
    paneKey: ra.entry.paneKey,
    entry: ra.entry,
    tab: ra.tab,
    agentType: ra.agentType,
    state: 'done',
    startedAt: ra.startedAt
  }
}

export function collectRetainedAgentsOnDisappear(args: {
  previousAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  currentAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  retentionSuppressedPaneKeys: Record<string, true>
}): {
  toRetain: RetainedAgentEntry[]
  consumedSuppressedPaneKeys: string[]
} {
  const toRetain: RetainedAgentEntry[] = []
  const consumedSuppressedPaneKeys: string[] = []

  for (const [paneKey, prev] of args.previousAgents) {
    if (args.currentAgents.has(paneKey) || args.retainedAgentsByPaneKey[paneKey]) {
      continue
    }
    if (args.retentionSuppressedPaneKeys[paneKey]) {
      consumedSuppressedPaneKeys.push(paneKey)
      continue
    }
    // Why: only keep a sticky snapshot when the agent finished cleanly
    // (state === 'done' and not interrupted). Explicit teardown paths mark
    // pane keys as suppression candidates, so a close/quit/crash cannot
    // resurrect a stale `done` row on the next sync.
    const lastState = prev.row.state
    const wasInterrupted = prev.row.entry.interrupted === true
    if (lastState !== 'done' || wasInterrupted) {
      continue
    }
    toRetain.push({
      entry: prev.row.entry,
      worktreeId: prev.worktreeId,
      tab: prev.row.tab,
      agentType: prev.row.agentType,
      startedAt: prev.row.startedAt
    })
  }

  return { toRetain, consumedSuppressedPaneKeys }
}

function computeDominant(agents: DashboardAgentRow[]): DashboardWorktreeCard['dominantState'] {
  if (agents.length === 0) {
    return 'idle'
  }
  let hasWorking = false
  let hasDone = false
  for (const agent of agents) {
    if (agent.state === 'blocked' || agent.state === 'waiting') {
      return 'blocked'
    }
    if (agent.state === 'working') {
      hasWorking = true
    }
    if (agent.state === 'done') {
      hasDone = true
    }
  }
  if (hasWorking) {
    return 'working'
  }
  if (hasDone) {
    return 'done'
  }
  return 'idle'
}
