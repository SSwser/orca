import { useState, useMemo } from 'react'
import type {
  DashboardRepoGroup,
  DashboardWorktreeCard,
  DashboardAgentRow
} from './useDashboardData'

export type DashboardFilter = 'active' | 'all' | 'blocked' | 'done'

export type FilteredDashboardGroup = {
  repo: DashboardRepoGroup['repo']
  worktrees: DashboardWorktreeCard[]
  /** Earliest startedAt across all worktrees in this group. Stable once the
   *  group has any agent — used for deterministic ordering between groups. */
  earliestStartedAt: number
}

// Why: filters apply to individual AGENTS, not worktrees. Previously we filtered
// by the worktree's dominantState, so a done agent stayed visible under the
// 'active' tab if a sibling agent in the same worktree was working — which
// defeats the point of the filter. Agent-level filtering keeps the worktree
// grouping intact but hides rows whose state doesn't match.
function matchesAgent(agent: DashboardAgentRow, filter: DashboardFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return agent.state === 'working'
    case 'blocked':
      return agent.state === 'blocked' || agent.state === 'waiting'
    case 'done':
      return agent.state === 'done'
  }
}

// Why: search also matches per-agent — so a typo'd prompt in one agent doesn't
// drag its unrelated siblings into the visible set. Repo/worktree/branch hits
// still surface the whole worktree row (keep all its agents) because at that
// point the user is looking for the *worktree*, not a specific agent inside it.
function worktreeMetaMatches(card: DashboardWorktreeCard, q: string): boolean {
  if (card.repo.displayName.toLowerCase().includes(q)) {
    return true
  }
  if (card.worktree.displayName.toLowerCase().includes(q)) {
    return true
  }
  const branch = card.worktree.branch?.toLowerCase() ?? ''
  return branch.includes(q)
}

function agentMatchesSearch(agent: DashboardAgentRow, q: string): boolean {
  if (agent.entry.prompt?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.toolName?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.toolInput?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.lastAssistantMessage?.toLowerCase().includes(q)) {
    return true
  }
  return agent.agentType.toLowerCase().includes(q)
}

export function useDashboardFilter(
  groups: DashboardRepoGroup[],
  searchQuery: string
): {
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
  filteredGroups: FilteredDashboardGroup[]
  filteredWorktrees: DashboardWorktreeCard[]
  hasResults: boolean
} {
  const [filter, setFilter] = useState<DashboardFilter>('all')

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const out: FilteredDashboardGroup[] = []
    for (const group of groups) {
      const worktrees: DashboardWorktreeCard[] = []
      for (const wt of group.worktrees) {
        const stateMatched = wt.agents.filter((a) => matchesAgent(a, filter))
        if (stateMatched.length === 0) {
          continue
        }
        const agents: DashboardAgentRow[] =
          q.length === 0 || worktreeMetaMatches(wt, q)
            ? stateMatched
            : stateMatched.filter((a) => agentMatchesSearch(a, q))
        // Why: drop worktrees whose agents are all filtered out — an empty
        // row would just be noise in the list.
        if (agents.length === 0) {
          continue
        }
        worktrees.push({ ...wt, agents })
      }
      if (worktrees.length === 0) {
        continue
      }
      // Why: sort worktrees within a group by earliest-started agent asc.
      // Stable once populated — a new agent starting in a sibling worktree
      // doesn't reshuffle this one while the user reads.
      worktrees.sort((a, b) => a.earliestStartedAt - b.earliestStartedAt)
      out.push({
        repo: group.repo,
        worktrees,
        earliestStartedAt: worktrees[0]?.earliestStartedAt ?? 0
      })
    }
    // Why: sort groups by the earliest-started worktree asc for the same
    // "stop moving while I read" reason. Repos with no activity yet get 0
    // and fall to the top, which is fine since they render empty anyway.
    out.sort((a, b) => a.earliestStartedAt - b.earliestStartedAt)
    return out
  }, [groups, filter, searchQuery])

  const filteredWorktrees = useMemo(
    () => filteredGroups.flatMap((g) => g.worktrees),
    [filteredGroups]
  )

  const hasResults = filteredWorktrees.length > 0

  return {
    filter,
    setFilter,
    filteredGroups,
    filteredWorktrees,
    hasResults
  }
}
