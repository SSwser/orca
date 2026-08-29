import type { WorkerDispatchState } from './types'

export type WorkerExecutionLifecycleState =
  | 'owned'
  | 'retained'
  | 'release_requested'
  | 'release_closing'
  | 'release_unknown'
  | 'contained'
  | 'released'
  | 'transferred'
  | 'user_owned'
  | 'external'

export type WorkerTerminalRetainedReason =
  | 'external_terminal'
  | 'ownership_transferred'
  | 'user_takeover'
  | 'user_requested'
  | 'no_owned_resource'
  | 'identity_unproven'
  | 'legacy_ambiguous'
  | 'lost_custody'
  | 'federation_unsupported'

export type WorkerTerminalArchiveStatus = 'captured' | 'empty' | 'unavailable'

type WorkerExecutionResourceBase = {
  id: string
  origin_dispatch_id: string
  owner_dispatch_id: string
  prior_owner_dispatch_ids: string
  worktree_id: string | null
  host_scope: string | null
  lifecycle_state: WorkerExecutionLifecycleState
  retained_reason: string | null
  release_requested_at: string | null
  release_completed_at: string | null
  release_error: string | null
  archive_source: string | null
  archive_status: WorkerTerminalArchiveStatus | null
  created_at: string
  updated_at: string
}

export type WorkerTerminalResourceRow = WorkerExecutionResourceBase & {
  resource_kind: 'terminal'
  terminal_handle: string
  pane_key: string | null
  process_incarnation: string | null
}

export type WorkerExecutionResourceRow = WorkerTerminalResourceRow

export type WorkerTerminalLifecycleState = WorkerExecutionLifecycleState

// Terminal state exposed by worker-list; process accounting, never Task/Dispatch outcome.
export type WorkerTerminalListState =
  | 'active'
  | 'reclaimable'
  | 'retained'
  | 'release_pending'
  | 'release_unknown'
  | 'contained'
  | 'released'

export type WorkerDispatchListState = WorkerDispatchState | 'unsupervised'

export type WorkerTerminalArchiveRow = {
  dispatch_id: string
  resource_id: string
  kind: 'transcript_pin' | 'terminal_tail'
  content: string
  created_at: string
}

export const WORKER_SETTLED_STATES: readonly WorkerDispatchState[] = [
  'succeeded',
  'failed',
  'stopped',
  'abandoned'
]

export const WORKER_RELEASABLE_STATES: readonly WorkerDispatchState[] = ['succeeded', 'failed']

// Process accounting for worker-list; deliberately independent of Task/Dispatch outcome.
export function deriveWorkerTerminalListState(params: {
  workerState: WorkerDispatchListState
  agentTerminalHandle: string | null
  resource: WorkerTerminalResourceRow | null
}): WorkerTerminalListState | null {
  const { resource } = params
  if (!resource) {
    return params.agentTerminalHandle ? 'retained' : null
  }
  if (resource.lifecycle_state === 'released') {
    return 'released'
  }
  if (resource.lifecycle_state === 'contained') {
    return 'contained'
  }
  if (resource.lifecycle_state === 'release_unknown') {
    return 'release_unknown'
  }
  if (
    resource.lifecycle_state === 'release_requested' ||
    resource.lifecycle_state === 'release_closing'
  ) {
    return 'release_pending'
  }
  if (resource.lifecycle_state !== 'owned') {
    return 'retained'
  }
  if (
    params.workerState !== 'unsupervised' &&
    WORKER_RELEASABLE_STATES.includes(params.workerState)
  ) {
    return 'reclaimable'
  }
  return params.workerState !== 'unsupervised' && WORKER_SETTLED_STATES.includes(params.workerState)
    ? 'retained'
    : 'active'
}
