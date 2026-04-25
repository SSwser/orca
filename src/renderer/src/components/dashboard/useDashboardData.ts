import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { Repo, Worktree, TerminalTab } from '../../../../shared/types'

// ─── Dashboard data types ─────────────────────────────────────────────────────

export type DashboardAgentRow = {
  paneKey: string
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  state: string
  /** When this agent first began reporting status. Derived from the oldest
   *  stateHistory entry, falling back to updatedAt when no history exists yet.
   *  Used to sort agents by when they started. */
  startedAt: number
}

export type DashboardWorktreeCard = {
  repo: Repo
  worktree: Worktree
  agents: DashboardAgentRow[]
  /** Highest-priority agent state for filtering.
   *  Priority: blocked > working > done > idle.
   *  `waiting` is folded into `blocked` — both are attention-needed states. */
  dominantState: 'working' | 'blocked' | 'done' | 'idle'
  /** Earliest startedAt across all agents in this worktree. Once the worktree
   *  has at least one agent, this value is stable — new agents starting in
   *  the same worktree do not change it. Sorting worktrees by this value
   *  asc keeps list order stable while the user is reading. */
  earliestStartedAt: number
}

export type DashboardRepoGroup = {
  repo: Repo
  worktrees: DashboardWorktreeCard[]
  /** Count of agents in attention-needed states (blocked/waiting). */
  attentionCount: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeDominantState(agents: DashboardAgentRow[]): DashboardWorktreeCard['dominantState'] {
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

// Why: the dashboard only surfaces agents that have reported state via a hook.
// A tab hosting a shell, a REPL before its first turn, or an agent we have no
// hook integration for will have no entry here — and that's correct. The
// dashboard's job is to show *agent work in progress*, not to guess which
// terminals might contain an agent.
function buildAgentRowsForWorktree(
  worktreeId: string,
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): DashboardAgentRow[] {
  const tabs = tabsByWorktree[worktreeId] ?? []
  const rows: DashboardAgentRow[] = []

  for (const tab of tabs) {
    const explicitEntries = Object.values(agentStatusByPaneKey).filter((entry) =>
      entry.paneKey.startsWith(`${tab.id}:`)
    )
    for (const entry of explicitEntries) {
      rows.push({
        paneKey: entry.paneKey,
        entry,
        tab,
        agentType: entry.agentType ?? 'unknown',
        state: entry.state,
        // Why: the oldest stateHistory entry's startedAt is the agent's original
        // "first seen" timestamp. When history is empty the entry is brand new,
        // so updatedAt is the best start-time approximation available.
        startedAt: entry.stateHistory[0]?.startedAt ?? entry.updatedAt
      })
    }
  }

  return rows
}

function buildDashboardData(
  repos: Repo[],
  worktreesByRepo: Record<string, Worktree[]>,
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): DashboardRepoGroup[] {
  return repos.map((repo) => {
    const worktrees = (worktreesByRepo[repo.id] ?? [])
      .filter((w) => !w.isArchived)
      .map((worktree) => {
        const agents = buildAgentRowsForWorktree(worktree.id, tabsByWorktree, agentStatusByPaneKey)
        // Why: sort agents within a worktree oldest-first by startedAt. A new
        // agent appears at the BOTTOM so it doesn't shove the row the user
        // is currently reading down the list. Stable order also means
        // retained/live transitions don't reshuffle siblings. Users care
        // less about "which is newest" than "let this list stop moving
        // while I read it".
        agents.sort((a, b) => a.startedAt - b.startedAt)
        // Why: earliestStartedAt (oldest agent in the worktree) is stable once
        // the worktree has any agent at all. Using it for outer sorts means
        // a brand-new agent in a different worktree no longer shoves this
        // card around while the user is reading.
        const earliestStartedAt = agents.length > 0 ? agents[0].startedAt : 0
        return {
          repo,
          worktree,
          agents,
          dominantState: computeDominantState(agents),
          earliestStartedAt
        } satisfies DashboardWorktreeCard
      })

    const attentionCount = worktrees.reduce(
      (count, wt) =>
        count + wt.agents.filter((a) => a.state === 'blocked' || a.state === 'waiting').length,
      0
    )

    return { repo, worktrees, attentionCount } satisfies DashboardRepoGroup
  })
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDashboardData(): DashboardRepoGroup[] {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries expire,
  // even if no new PTY data arrives.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  return useMemo(
    () => buildDashboardData(repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey, agentStatusEpoch]
  )
}
