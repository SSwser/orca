import type { OrchestrationDb } from '../../orchestration/db'
import { isEquivalentPaneKey } from '../../orchestration/db/pane-key-match'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import type { OrcaRuntimeService } from '../../orca-runtime'

function workerTerminalResourceIdentityIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  const authority = runtime.getOrchestrationDispatchAuthority(resource.terminal_handle)
  const paneKey = runtime.getTerminalPaneKey(resource.terminal_handle)
  return Boolean(
    resource.owner_dispatch_id === dispatchId &&
    ['release_requested', 'release_closing', 'release_unknown'].includes(
      resource.lifecycle_state
    ) &&
    worker?.agent_terminal_handle === resource.terminal_handle &&
    authority &&
    authority.terminalHandle === resource.terminal_handle &&
    authority.processIncarnation === resource.process_incarnation &&
    authority.paneKey &&
    resource.pane_key &&
    isEquivalentPaneKey(authority.paneKey, resource.pane_key) &&
    paneKey &&
    isEquivalentPaneKey(paneKey, resource.pane_key) &&
    resource.host_scope === JSON.stringify(authority.hostScope) &&
    runtime.getTerminalProcessIncarnation(resource.terminal_handle) ===
      resource.process_incarnation &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

export function workerTerminalLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  return Boolean(
    workerTerminalResourceIdentityIsCurrent(runtime, db, dispatchId, resource) &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: runtime.getTerminalPaneKey(resource.terminal_handle),
      processIncarnation: runtime.getTerminalProcessIncarnation(resource.terminal_handle)
    })
  )
}

export function workerTerminalExitedIdentityIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  const dispatch = db.getDispatchContextById(dispatchId)
  const paneKey = runtime.getTerminalPaneKey(resource.terminal_handle)
  const processIncarnation = runtime.getTerminalProcessIncarnation(resource.terminal_handle)
  return Boolean(
    resource.owner_dispatch_id === dispatchId &&
    ['release_requested', 'release_closing', 'release_unknown'].includes(
      resource.lifecycle_state
    ) &&
    resource.pane_key &&
    resource.process_incarnation &&
    resource.host_scope &&
    worker?.agent_terminal_handle === resource.terminal_handle &&
    dispatch?.assignee_handle === resource.terminal_handle &&
    dispatch.assignee_pane_key &&
    isEquivalentPaneKey(dispatch.assignee_pane_key, resource.pane_key) &&
    dispatch.process_incarnation === resource.process_incarnation &&
    paneKey &&
    isEquivalentPaneKey(paneKey, resource.pane_key) &&
    processIncarnation === resource.process_incarnation &&
    db.isDispatchProcessCurrent({ dispatchId, paneKey, processIncarnation }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

export function workerTerminalHasStopOwnedExitEvidence(
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  const dispatch = db.getDispatchContextById(dispatchId)
  const archive = db.getWorkerTerminalArchive(dispatchId)
  return Boolean(
    resource.owner_dispatch_id === dispatchId &&
    resource.lifecycle_state === 'release_unknown' &&
    resource.process_incarnation &&
    resource.host_scope &&
    resource.pane_key &&
    resource.archive_source &&
    (resource.archive_status === 'captured' || resource.archive_status === 'empty') &&
    archive?.resource_id === resource.id &&
    worker?.state === 'stopped' &&
    worker.stage === 'process_stopped' &&
    worker.agent_terminal_handle === resource.terminal_handle &&
    dispatch?.status === 'failed' &&
    dispatch.last_failure === 'stopped' &&
    dispatch.termination_reason === 'operator_close' &&
    dispatch.capability_revoked_at &&
    dispatch.assignee_handle === resource.terminal_handle &&
    dispatch.assignee_pane_key &&
    isEquivalentPaneKey(dispatch.assignee_pane_key, resource.pane_key) &&
    dispatch.process_incarnation === resource.process_incarnation &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}
