import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import { orchestrationTimestampToMs } from './orchestration-worker-output'
import { inspectWorkerTerminal } from './orchestration-worker-observation'
import { workerTerminalExitedIdentityIsCurrent } from './orchestration-worker-release-identity'
import { captureWorkerTerminalArchiveOnce } from './orchestration-worker-archive-capture'
import type {
  WorkerReleaseReceipt,
  WorkerTerminalReleaseArgs
} from './orchestration-worker-release-completion'

export async function completeExitedWorkerTerminalRelease(
  args: WorkerTerminalReleaseArgs,
  identityFailure: () => WorkerReleaseReceipt
): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource } = args
  if (
    !resource.process_incarnation ||
    !resource.host_scope ||
    !workerTerminalExitedIdentityIsCurrent(runtime, db, dispatchId, resource)
  ) {
    return identityFailure()
  }
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker) {
    return identityFailure()
  }
  const archive = await captureWorkerTerminalArchiveOnce({
    runtime,
    db,
    dispatchId,
    terminalHandle: resource.terminal_handle,
    attachedAtMs: orchestrationTimestampToMs(worker.created_at)
  })
  const releasing = db.commitWorkerTerminalArchiveForRelease({
    dispatchId,
    resourceId: resource.id,
    ...(archive.kind && archive.content ? { kind: archive.kind, content: archive.content } : {}),
    archiveSource: archive.source,
    archiveStatus: archive.status
  })
  const confirmation = await inspectWorkerTerminal(runtime, db, dispatchId)
  const confirmed =
    confirmation.status === 'exited' &&
    confirmation.exact &&
    workerTerminalExitedIdentityIsCurrent(runtime, db, dispatchId, releasing)
  if (!confirmed) {
    return exitedReleaseUnverifiableReceipt({ ...args, resource: releasing })
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  if (resource.pane_key) {
    runtime.notifyWorkerTerminalReleased(resource.pane_key)
  }
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction: 'none',
    archive: archiveSummary(released)
  }
}

function exitedReleaseUnverifiableReceipt(args: WorkerTerminalReleaseArgs): WorkerReleaseReceipt {
  const reason = 'The recorded exited terminal could not be re-proven on its execution host.'
  const unknown = args.db.markWorkerTerminalReleaseUnknown(args.resource.id, reason)
  return {
    dispatchId: args.dispatchId,
    state: 'release_unknown',
    processAction: 'none',
    archive: archiveSummary(unknown),
    lastError: unknown.release_error ?? reason,
    recovery: 'Restore exact execution-host evidence before retrying; no process action was taken.'
  }
}

function archiveSummary(
  resource: WorkerTerminalResourceRow | null
): { source: string | null; status: string | null } | null {
  if (!resource?.archive_source && !resource?.archive_status) {
    return null
  }
  return { source: resource.archive_source, status: resource.archive_status }
}
