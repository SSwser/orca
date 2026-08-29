import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-completion'
import {
  workerTerminalHasStopOwnedExitEvidence,
  workerTerminalLeaseIsCurrent
} from './orchestration-worker-release-identity'

type ReconciliationInput = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
}

async function inspectReleaseLiveness({
  runtime,
  db,
  dispatchId,
  resource
}: ReconciliationInput): Promise<'live' | 'exited' | 'unverifiable'> {
  if (workerTerminalHasStopOwnedExitEvidence(db, dispatchId, resource)) {
    return 'exited'
  }
  return resource.process_incarnation
    ? await runtime.inspectTerminalProcessIncarnationLiveness(
        resource.process_incarnation,
        resource.host_scope
      )
    : 'unverifiable'
}

function settleExitedRelease(
  { runtime, db, dispatchId, resource }: ReconciliationInput,
  liveness: 'live' | 'exited' | 'unverifiable'
): WorkerReleaseReceipt | null {
  if (!resource.process_incarnation || liveness !== 'exited') {
    return null
  }
  const reconciled = db.settleDeadWorkerTerminalRelease({
    requestingDispatchId: dispatchId,
    resourceId: resource.id,
    processIncarnation: resource.process_incarnation
  })
  if (reconciled.disposition === 'released') {
    runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
    return {
      dispatchId,
      state: 'released',
      processAction: 'none',
      archive: archiveSummary(reconciled.resource)
    }
  }
  return reconciled.resource.lifecycle_state === 'released'
    ? {
        dispatchId,
        state: 'already_released',
        processAction: 'none',
        archive: archiveSummary(reconciled.resource)
      }
    : null
}

export async function reconcileSettledWorkerTerminalRelease({
  runtime,
  db,
  dispatchId,
  resource
}: ReconciliationInput): Promise<WorkerReleaseReceipt> {
  const liveness = await inspectReleaseLiveness({ runtime, db, dispatchId, resource })
  const settled = settleExitedRelease({ runtime, db, dispatchId, resource }, liveness)
  if (settled) {
    return settled
  }
  db.ensureWorkerTerminalReleaseUnknownMessage({ dispatchId, resourceId: resource.id })
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'release_unknown',
    processAction: 'none',
    archive: archiveSummary(resource),
    ...(resource.release_error ? { lastError: resource.release_error } : {}),
    recovery:
      liveness === 'live'
        ? 'The exact recorded process remains live after terminal custody was lost; no process action was taken.'
        : liveness === 'exited'
          ? 'Exact process exit was observed, but the settled resource identity changed; no process action was taken.'
          : 'The exact recorded process could not be verified after terminal custody was lost; no process action was taken.'
  }
}

export async function reconcileUnknownWorkerTerminalRelease({
  runtime,
  db,
  dispatchId,
  resource
}: ReconciliationInput): Promise<WorkerReleaseReceipt> {
  const processIncarnation = resource.process_incarnation
  const liveness = await inspectReleaseLiveness({ runtime, db, dispatchId, resource })
  const settled = settleExitedRelease({ runtime, db, dispatchId, resource }, liveness)
  if (settled) {
    return settled
  }
  const exactLiveLeaseCurrent = Boolean(
    processIncarnation &&
    liveness === 'live' &&
    workerTerminalLeaseIsCurrent(runtime, db, dispatchId, resource)
  )
  if (processIncarnation && exactLiveLeaseCurrent) {
    const resumed = db.resumeUnknownWorkerTerminalRelease({
      dispatchId,
      resourceId: resource.id,
      processIncarnation
    })
    if (['release_requested', 'release_closing'].includes(resumed.resource.lifecycle_state)) {
      return completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId,
        resource: resumed.resource,
        mode: 'reconciliation'
      })
    }
    if (resumed.resource.lifecycle_state === 'released') {
      return {
        dispatchId,
        state: 'already_released',
        processAction: 'none',
        archive: archiveSummary(resumed.resource)
      }
    }
  }
  const worker = db.getWorkerDispatch(dispatchId)
  if (worker && ['stopped', 'abandoned'].includes(worker.state)) {
    db.ensureWorkerTerminalReleaseUnknownMessage({ dispatchId, resourceId: resource.id })
    runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  }
  return {
    dispatchId,
    state: 'release_unknown',
    processAction: 'none',
    archive: archiveSummary(resource),
    ...(resource.release_error ? { lastError: resource.release_error } : {}),
    recovery:
      liveness === 'live'
        ? exactLiveLeaseCurrent
          ? 'The exact recorded process is live, but the release state changed concurrently; no process action was taken.'
          : 'The exact recorded process is live, but its terminal or Dispatch authority conflicts with the recorded lease; no process action was taken.'
        : liveness === 'exited'
          ? 'Exact process exit was observed, but resource ownership or release identity changed; no process action was taken.'
          : 'The exact recorded process could not be verified; restore its execution-host inventory before retrying. No process action was taken.'
  }
}
