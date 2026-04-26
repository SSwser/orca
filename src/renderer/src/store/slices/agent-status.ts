import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentType,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

/** Snapshot of a finished (or vanished) agent status entry, kept around so
 *  the dashboard + sidebar hover can continue showing the completion until the
 *  user acknowledges it by clicking the worktree. The `worktreeId` is stamped
 *  at retention time so we know where the row belongs even after the tab/pty
 *  it came from has gone away. */
export type RetainedAgentEntry = {
  entry: AgentStatusEntry
  worktreeId: string
  /** Snapshot of the tab the agent lived in at retention time. We keep the
   *  full record (not just an id) because the tab may be gone from
   *  `tabsByWorktree` by the time the retained row is rendered. */
  tab: TerminalTab
  agentType: AgentType
  startedAt: number
}

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${paneId}` composite.
   *  Real-time only — lives in renderer memory, not persisted to disk. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number

  /** Retained "done" entries — snapshots of agents that have disappeared from
   *  `agentStatusByPaneKey`. Keyed by paneKey so re-appearance of the same pane
   *  overwrites the snapshot. Shared between the dashboard and the sidebar
   *  agent-status hover so the two surfaces display identical rows. */
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>

  /** Pane keys explicitly torn down (pane close, tab close, PTY exit, manual
   *  dismissal) and therefore forbidden from being re-retained on their next
   *  disappearance. Consumed by the retention sync as a one-shot suppressor. */
  retentionSuppressedPaneKeys: Record<string, true>

  /** Update or insert an agent status entry from a status payload. */
  setAgentStatus: (
    paneKey: string,
    payload: ParsedAgentStatusPayload,
    terminalTitle?: string
  ) => void

  /** Remove a single entry (e.g., when a pane's terminal exits). */
  removeAgentStatus: (paneKey: string) => void

  /** Remove all entries whose paneKey starts with the given prefix.
   *  Used when a tab is closed — same prefix-sweep as cacheTimerByKey cleanup. */
  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove a single entry AND suppress re-retention on its next disappearance.
   *  Used for USER-INITIATED dismissal (the dashboard/hover X button), where
   *  the user is telling us "I've seen this, make it stay gone".
   *
   *  Do NOT route PTY-exit / tab-close / pane-close teardowns through here:
   *  those paths call removeAgentStatus instead (no retention suppression), so
   *  a 'done' agent's row can still be retained after its terminal dies — the
   *  user may still want to click through to review output even though the
   *  underlying process has exited. */
  dropAgentStatus: (paneKey: string) => void

  /** Retain agent snapshots (called by the top-level retention sync effect).
   *  Accepts an array so multiple agents disappearing in the same frame
   *  produce a single set(...) — avoids intermediate states visible
   *  mid-loop to consumers. */
  retainAgents: (entries: RetainedAgentEntry[]) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void

  /** Clear one-shot teardown suppressors after the retention sync observes
   *  that disappearance and decides not to retain the row. */
  clearRetentionSuppressedPaneKeys: (paneKeys: string[]) => void
}

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  set,
  get
) => {
  // Why: tests that call setAgentStatus must use vi.useFakeTimers() or remove the entry before teardown — otherwise a real 30-minute setTimeout leaks into the test process.
  let staleExpiryTimer: ReturnType<typeof setTimeout> | null = null

  const clearStaleExpiryTimer = (): void => {
    if (staleExpiryTimer !== null) {
      clearTimeout(staleExpiryTimer)
      staleExpiryTimer = null
    }
  }

  const scheduleNextFreshnessExpiry = (): void => {
    clearStaleExpiryTimer()

    const entries = Object.values(get().agentStatusByPaneKey)
    if (entries.length === 0) {
      return
    }

    const now = Date.now()
    let nextExpiryAt = Number.POSITIVE_INFINITY
    // Why: skip entries already past the stale boundary — they each contribute
    // exactly one epoch bump at crossing, and rescheduling on them would spin
    // the timer forever because the bump doesn't clear them from the map
    // (retention is intentional so freshness-aware selectors can decay).
    for (const entry of entries) {
      const expiryAt = entry.updatedAt + AGENT_STATUS_STALE_AFTER_MS
      if (expiryAt > now) {
        nextExpiryAt = Math.min(nextExpiryAt, expiryAt)
      }
    }
    if (!Number.isFinite(nextExpiryAt)) {
      return
    }

    // Why: +1 ms ensures the timer fires strictly after the stale boundary,
    // so isExplicitAgentStatusFresh (which uses `<=`) flips to stale when the
    // timer runs. Without the +1, float/rounding could leave the entry "just
    // fresh enough" at the tick, delaying the epoch bump by one tick.
    const delayMs = nextExpiryAt - now + 1
    staleExpiryTimer = setTimeout(() => {
      staleExpiryTimer = null
      // Why: freshness is time-based, not event-based. Advancing these epochs
      // at the exact stale boundary forces all freshness-aware selectors to
      // recompute — and re-sorts WorktreeList — even when no new PTY output
      // arrives. sortEpoch must bump in lockstep with agentStatusEpoch because
      // a stale transition can legitimately change worktree ordering.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
      scheduleNextFreshnessExpiry()
    }, delayMs)
  }

  return {
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {},
    retentionSuppressedPaneKeys: {},

    setAgentStatus: (paneKey, payload, terminalTitle) => {
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        // Why: terminalTitle is identity-like — it labels the pane itself, not
        // the current turn's activity. Preserve the prior value when a ping
        // omits it so the pane label does not flicker out between hook events.
        // Unlike the tool/prompt/assistant fields below (which legitimately
        // clear on a fresh turn), a missing title means "no update", not "the
        // pane has no title any more".
        const effectiveTitle = terminalTitle ?? existing?.terminalTitle

        // Why: build up a rolling log of state transitions so the dashboard can
        // render activity blocks showing what the agent has been doing. Only push
        // when the state actually changes to avoid duplicate entries from prompt-
        // only updates within the same state.
        let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
        if (existing && existing.state !== payload.state) {
          history = [
            ...history,
            {
              state: existing.state,
              prompt: existing.prompt,
              // Why: use stateStartedAt (not updatedAt) so the history row
              // reflects when the state was first reported, not the most
              // recent within-state ping (tool/prompt updates refresh
              // updatedAt but not stateStartedAt).
              startedAt: existing.stateStartedAt,
              // Why: preserve the interrupt flag on the historical `done` entry
              // so activity-block views can render past cancellations as such.
              interrupted: existing.interrupted
            }
          ]
          if (history.length > AGENT_STATE_HISTORY_MAX) {
            history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
          }
        }

        const now = Date.now()
        // Why: stateStartedAt anchors to the first time this state was
        // reported. Carry forward the prior value on tool/prompt pings within
        // the same state so stateHistory[].startedAt reflects true state-onset
        // (see AgentStatusEntry.stateStartedAt docs).
        const stateStartedAt =
          existing && existing.state === payload.state ? existing.stateStartedAt : now

        // Why: tool/assistant fields come pre-merged from the main-process
        // cache (see `resolveToolState` in server.ts), so the payload always
        // carries the authoritative current snapshot — including clears on a
        // fresh turn. Writing through directly (no existing fallback) is what
        // lets a `UserPromptSubmit` reset clear stale tool lines in the UI.
        const entry: AgentStatusEntry = {
          state: payload.state,
          prompt: payload.prompt,
          updatedAt: now,
          stateStartedAt,
          // Why: unlike tool/prompt/assistant fields (which legitimately clear on a
          // fresh turn), agentType is the agent's identity for the pane — it does
          // not change between updates. Preserve the prior value when a payload
          // omits it so the icon/label does not flicker out between hook pings.
          // 'unknown' is the sentinel for "agent didn't identify itself" in
          // WellKnownAgentType. Treat it like absence so a well-known prior
          // identity (e.g. 'claude' learned from an earlier hook ping) isn't
          // stomped by a later ping that lost the identity (e.g. legacy/partial
          // integrations).
          agentType:
            payload.agentType && payload.agentType !== 'unknown'
              ? payload.agentType
              : existing?.agentType,
          paneKey,
          terminalTitle: effectiveTitle,
          stateHistory: history,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
          lastAssistantMessage: payload.lastAssistantMessage,
          // Why: interrupted lives on `done` only. parseAgentStatusPayload
          // already clamps it to `undefined` for non-done states, so writing
          // the field through directly preserves truth for done and resets
          // it when a new turn starts (working → Stop reprices it).
          interrupted: payload.interrupted
        }
        // Why: `agentStatusEpoch` bumps on every update because visual +
        // freshness selectors (WorktreeCard status, hover content) care about
        // tool-name/prompt/assistant-message churn within a turn. `sortEpoch`,
        // on the other hand, bumps only when sort-relevant inputs change —
        // avoiding sidebar re-sorts on every tool/prompt event would stress
        // the smart-sort debounce for no reason. Sort-relevant inputs are:
        //   1. `state` transitions — sort score is a function of state.
        //   2. Freshness transitions (stale → fresh) — `computeSmartScoreFromSignals`
        //      in smart-sort.ts filters entries through
        //      `isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)`
        //      (30-min TTL). A stale entry that refreshes with the SAME state
        //      goes from "not contributing" to contributing +60 (working) or
        //      +35 (blocked/waiting) to the score — order must update. The new
        //      entry below always has `updatedAt = now`, so it is fresh; we
        //      only need to detect the stale→fresh flip on `existing`.
        const wasFresh =
          !!existing && isExplicitAgentStatusFresh(existing, now, AGENT_STATUS_STALE_AFTER_MS)
        const sortRelevantChange = !existing || existing.state !== payload.state || !wasFresh
        // Why: a new status event means the agent is live again — lift any
        // one-shot retention suppressor so the row can be retained normally
        // on its next disappearance. setAgentStatus fires on every PTY status
        // update (high frequency), so only clone retentionSuppressedPaneKeys
        // when there is actually a suppressor to remove — otherwise every
        // status ping would churn that map reference and force spurious
        // re-renders in any subscriber selecting on it.
        const hasSuppressor = paneKey in s.retentionSuppressedPaneKeys
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (hasSuppressor) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          delete nextRetentionSuppressedPaneKeys[paneKey]
        }
        return {
          agentStatusByPaneKey: { ...s.agentStatusByPaneKey, [paneKey]: entry },
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: sortRelevantChange ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      // Why: schedule after set completes so the timer reads the updated map.
      // queueMicrotask avoids re-entry into the zustand store during set.
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    removeAgentStatus: (paneKey) => {
      if (!(paneKey in get().agentStatusByPaneKey)) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        delete next[paneKey]
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing an
        // agent can legitimately change worktree sort order, same rationale
        // as setAgentStatus.
        return {
          agentStatusByPaneKey: next,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    removeAgentStatusByTabPrefix: (tabIdPrefix) => {
      const prefix = `${tabIdPrefix}:`
      const currentKeys = Object.keys(get().agentStatusByPaneKey)
      const toRemove = currentKeys.filter((k) => k.startsWith(prefix))
      if (toRemove.length === 0) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        for (const key of toRemove) {
          delete next[key]
        }
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing
        // agents can legitimately change worktree sort order, same rationale
        // as setAgentStatus. The pre-check guards against spurious bumps when
        // no keys matched the prefix.
        return {
          agentStatusByPaneKey: next,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    dropAgentStatus: (paneKey) => {
      const hasLiveBeforeSet = paneKey in get().agentStatusByPaneKey
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        // Why: bail when there is genuinely nothing to do. The old guard
        // `!hasLive && !hasRetained && alreadySuppressed` leaked a phantom
        // suppressor write in the `!hasLive && !hasRetained && !alreadySuppressed`
        // case. With the hasLive-gated suppressor below, a no-op drop on a
        // paneKey with no live and no retained entry truly has nothing to
        // change, so short-circuit here.
        if (!hasLive && !hasRetained) {
          return s
        }

        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }

        const nextRetained = hasRetained
          ? { ...s.retainedAgentsByPaneKey }
          : s.retainedAgentsByPaneKey
        if (hasRetained) {
          delete nextRetained[paneKey]
        }

        // Why: explicit teardown means "the user is done with this row", so
        // the next retention sync must not resurrect it from the previous frame.
        //
        // Why gate on hasLive: the suppressor is a one-shot flag consumed by
        // `collectRetainedAgentsOnDisappear` (useRetainedAgents.ts), which
        // iterates the PREVIOUS render's LIVE agents to decide what to
        // retain. If we dismiss a retained-only row (no live entry at drop
        // time), no live→gone transition will ever fire for this paneKey, so
        // the suppressor would never be consumed and would leak indefinitely
        // — only clearing if the same paneKey later became live again via
        // setAgentStatus. A retained-only dismissal just needs the retained
        // entry removed; there is no live-agent resurrection risk to guard
        // against. Only spread retentionSuppressedPaneKeys when hasLive.
        //
        // Why the `!(paneKey in s.retentionSuppressedPaneKeys)` check: if a
        // suppressor is already present, re-spreading produces a new object
        // reference with identical contents and spuriously re-renders any
        // subscriber selecting on retentionSuppressedPaneKeys. Mirror the
        // guard used in setAgentStatus.
        const needsSuppressorWrite = hasLive && !(paneKey in s.retentionSuppressedPaneKeys)

        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetained,
          ...(needsSuppressorWrite
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch: hasLive ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          // Why: mirrors removeAgentStatus — dropping a live working/blocked
          // agent changes its contribution to the worktree sort score, so the
          // sidebar smart-sort must recompute. Without this bump, a user-
          // initiated dismissal via the dashboard/hovercard would leave the
          // sidebar ordering stale until some unrelated event repaired it.
          sortEpoch: hasLive ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      // Why: scheduleNextFreshnessExpiry only matters when the live map
      // changed — retained-only and no-op drops don't touch it. Gate on the
      // pre-set live presence so a noop drop on a paneKey with no live and
      // no retained entry (or a retained-only dismissal) skips the microtask.
      if (hasLiveBeforeSet) {
        queueMicrotask(() => scheduleNextFreshnessExpiry())
      }
    },

    retainAgents: (entries) => {
      // Why: retained entries are a pure read-overlay — consumers read
      // retainedAgentsByPaneKey directly each render, so no sort/status epoch
      // bump is needed. Retention does not participate in sort ordering.
      // Batching into a single set(...) keeps multi-agent disappearance atomic.
      if (entries.length === 0) {
        return
      }
      set((s) => {
        const next = { ...s.retainedAgentsByPaneKey }
        for (const retained of entries) {
          next[retained.entry.paneKey] = retained
        }
        return { retainedAgentsByPaneKey: next }
      })
    },

    dismissRetainedAgent: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        // Why: mirror dropAgentStatus's hasLive-gated suppressor. If the same
        // paneKey has BOTH a retained entry AND a concurrent live entry, simply
        // removing the retained row leaves the live entry free to vanish
        // cleanly on its next disappearance — and because
        // collectRetainedAgentsOnDisappear (useRetainedAgents.ts) only skips
        // paneKeys that are currently in retainedAgentsByPaneKey, the
        // just-dismissed row would be resurrected by a new retention snapshot.
        // Plant a one-shot suppressor so the next live→gone transition for
        // this paneKey is ignored by the retention sync.
        //
        // Gate on `paneKey in agentStatusByPaneKey`: with no live entry there
        // is no live→gone transition to guard against, and a stray suppressor
        // would leak indefinitely (same rationale as dropAgentStatus).
        const hasLive = paneKey in s.agentStatusByPaneKey
        if (!hasLive || paneKey in s.retentionSuppressedPaneKeys) {
          return { retainedAgentsByPaneKey: next }
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: {
            ...s.retentionSuppressedPaneKeys,
            [paneKey]: true
          }
        }
      })
    },

    dismissRetainedAgentsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (ra.worktreeId === worktreeId) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    },

    pruneRetainedAgents: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (!validWorktreeIds.has(ra.worktreeId)) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    },

    clearRetentionSuppressedPaneKeys: (paneKeys) => {
      set((s) => {
        let changed = false
        const next = { ...s.retentionSuppressedPaneKeys }
        for (const paneKey of paneKeys) {
          if (!(paneKey in next)) {
            continue
          }
          delete next[paneKey]
          changed = true
        }
        return changed ? { retentionSuppressedPaneKeys: next } : s
      })
    }
  }
}
