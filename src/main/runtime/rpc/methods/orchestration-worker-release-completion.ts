import type { OrchestrationDb } from '../../orchestration/db'
import type {
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../orchestration/worker-terminal-ownership'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import { inspectWorkerTerminal } from './orchestration-worker-observation'
import { orchestrationTimestampToMs } from './orchestration-worker-output'
import { workerTerminalLeaseIsCurrent } from './orchestration-worker-release-identity'
import { captureWorkerTerminalArchiveOnce } from './orchestration-worker-archive-capture'

export type WorkerReleaseReceipt = {
  dispatchId: string
  state:
    | 'released'
    | 'already_released'
    | 'retained'
    | 'release_pending'
    | 'release_unknown'
    | 'contained'
  reason?: WorkerTerminalRetainedReason
  processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

type WorkerTerminalReleaseArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  mode?: 'recovery' | 'reconciliation'
}

const activeReleaseByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, Promise<WorkerReleaseReceipt>>
>()

export function exposeWorkerTerminalResource(resource: WorkerTerminalResourceRow): {
  id: string
  lifecycleState: string
  retainedReason: string | null
  terminalHandle: string
  worktreeId: string | null
  originDispatchId: string
  ownerDispatchId: string
  releaseRequestedAt: string | null
  releaseCompletedAt: string | null
  releaseError: string | null
  archive: { source: string | null; status: string | null }
} {
  return {
    id: resource.id,
    lifecycleState: resource.lifecycle_state,
    retainedReason: resource.retained_reason,
    terminalHandle: resource.terminal_handle,
    worktreeId: resource.worktree_id,
    originDispatchId: resource.origin_dispatch_id,
    ownerDispatchId: resource.owner_dispatch_id,
    releaseRequestedAt: resource.release_requested_at,
    releaseCompletedAt: resource.release_completed_at,
    releaseError: resource.release_error,
    archive: { source: resource.archive_source, status: resource.archive_status }
  }
}

export function archiveSummary(
  resource: WorkerTerminalResourceRow | null
): { source: string | null; status: string | null } | null {
  if (!resource) {
    return null
  }
  if (!resource.archive_source && !resource.archive_status) {
    return null
  }
  return { source: resource.archive_source, status: resource.archive_status }
}

// Completes a durably requested release: re-prove exact identity, freeze output, close only the
// exact agent terminal, settle. Shared between the RPC method and the startup reconciler.
export function completeWorkerTerminalRelease(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  let activeByResource = activeReleaseByRuntime.get(args.runtime)
  if (!activeByResource) {
    activeByResource = new Map()
    activeReleaseByRuntime.set(args.runtime, activeByResource)
  }
  const active = activeByResource.get(args.resource.id)
  if (active) {
    return active
  }
  const release = completeWorkerTerminalReleaseOnce(args).finally(() => {
    if (activeByResource?.get(args.resource.id) === release) {
      activeByResource.delete(args.resource.id)
    }
  })
  activeByResource.set(args.resource.id, release)
  return release
}

async function completeWorkerTerminalReleaseOnce(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource } = args
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker || worker.agent_terminal_handle !== resource.terminal_handle) {
    return identityFailureReceipt(args)
  }
  const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
  if (observation.status === 'identity_changed') {
    return identityFailureReceipt(args)
  }
  if (args.mode === 'reconciliation' && ['missing', 'unattached'].includes(observation.status)) {
    return identityFailureReceipt(args)
  }
  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource)) {
    return identityFailureReceipt(args)
  }
  if (observation.status === 'missing' || observation.status === 'unattached') {
    if (args.mode === 'recovery') {
      // Inventory may still be incomplete during startup/reconnect discovery; defer.
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery:
          'The recorded terminal has not been rediscovered yet; recovery will retry after the next terminal inventory.'
      }
    }
    // Why: the handle resolves nowhere, but the PTY could have been re-homed after a restart —
    // claiming released would hide a live process; only an exact observation may settle it.
    const unknown = db.markWorkerTerminalReleaseUnknown(
      resource.id,
      'The recorded terminal no longer resolves; whether its process is gone cannot be proven.'
    )
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: archiveSummary(unknown),
      lastError: unknown.release_error ?? undefined,
      recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
    }
  }

  const archive = await captureWorkerTerminalArchiveOnce({
    runtime,
    db,
    dispatchId,
    terminalHandle: resource.terminal_handle,
    attachedAtMs: orchestrationTimestampToMs(worker.created_at)
  })
  const archiveSource = archive.source
  const archiveStatus = archive.status
  const releasing = db.commitWorkerTerminalArchiveForRelease({
    dispatchId,
    resourceId: resource.id,
    ...(archive.kind && archive.content ? { kind: archive.kind, content: archive.content } : {}),
    archiveSource,
    archiveStatus
  })
  if (releasing.lifecycle_state !== 'release_closing') {
    return {
      dispatchId,
      state: 'retained',
      reason: retainedReason(releasing),
      processAction: 'none',
      archive: archiveSummary(releasing)
    }
  }
  if (!workerTerminalLeaseIsCurrent(runtime, db, dispatchId, releasing)) {
    return identityFailureReceipt({ ...args, resource: releasing })
  }

  try {
    const close = await runtime.closeTerminal(resource.terminal_handle)
    if (!close.ptyKilled) {
      const reason = describeUnconfirmedAgentStop(close)
      const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
      return {
        dispatchId,
        state: 'release_unknown',
        processAction: 'none',
        archive: { source: archiveSource, status: archiveStatus },
        lastError: unknown.release_error ?? reason,
        recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (/disposed|not connected|unavailable/i.test(reason)) {
      // Durable intent exists; the owning endpoint is temporarily unreachable. Recovery retries.
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: { source: archiveSource, status: archiveStatus },
        lastError: reason,
        recovery:
          'The owning endpoint is temporarily unavailable; recovery will retry this release after reconnect without another coordinator decision.'
      }
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, reason)
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: { source: archiveSource, status: archiveStatus },
      lastError: unknown.release_error ?? reason,
      recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
    }
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction:
      observation.status === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal',
    archive: archiveSummary(released)
  }
}

function identityFailureReceipt(args: WorkerTerminalReleaseArgs): WorkerReleaseReceipt {
  if (args.mode === 'reconciliation') {
    const unknown = args.db.markWorkerTerminalReleaseUnknown(
      args.resource.id,
      'The recorded terminal no longer resolves to its exact process identity.'
    )
    return {
      dispatchId: args.dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: archiveSummary(unknown),
      lastError: unknown.release_error ?? undefined,
      recovery:
        'Restore the exact recorded terminal identity before retrying; no process action was taken.'
    }
  }
  const retained = args.db.revertWorkerTerminalReleaseToRetained(
    args.resource.id,
    'identity_unproven'
  )
  return {
    dispatchId: args.dispatchId,
    state: 'retained',
    reason: 'identity_unproven',
    processAction: 'none',
    archive: archiveSummary(retained)
  }
}

function retainedReason(resource: WorkerTerminalResourceRow): WorkerTerminalRetainedReason {
  if (resource.retained_reason) {
    return resource.retained_reason as WorkerTerminalRetainedReason
  }
  if (resource.lifecycle_state === 'user_owned') {
    return 'user_takeover'
  }
  return 'identity_unproven'
}
