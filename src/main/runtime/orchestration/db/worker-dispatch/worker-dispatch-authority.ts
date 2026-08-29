import { randomBytes } from 'node:crypto'
import { OrchestrationError } from '../../orchestration-error'
import { hashDispatchCapability } from '../dispatch-capability-hash'
import type { OrchestrationDb } from '../orchestration-db'

export function prepareStartingWorkerAuthority(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    launchTokenHash?: string
    worktreeId: string
    effects: unknown[]
    setupState: string
    hostScope?: string | null
    capability?: string
    // 'created': this worker-start operation created the agent terminal (including agent-first
    // worktree creation, whose effects receipt says 'reused_agent_terminal'). 'external': an
    // explicit --terminal reuse; ownership transfers only from an exact owned settled resource.
    terminalOwnership?: 'created' | 'external'
    generationOperation?: {
      operationId: string
      payloadFingerprint: string
      claimantId: string
      receipt: unknown
    }
  }
): string {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // Why: read inside the transaction so the guarded UPDATEs below cannot lose a race with a concurrent state change.
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    if (
      dispatch.launch_token_hash &&
      params.launchTokenHash &&
      dispatch.launch_token_hash !== params.launchTokenHash
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} already has a different launch-token commitment.`
      )
    }
    const existing = this.findActiveDispatchForAssignee(params.handle, params.paneKey)
    if (existing && existing.id !== params.dispatchId) {
      throw new Error(
        `Terminal ${params.handle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
      )
    }
    const capability = params.capability ?? `dcap_${randomBytes(32).toString('base64url')}`
    if (
      params.capability &&
      (worker.provisional_capability !== params.capability ||
        dispatch.capability_hash !== hashDispatchCapability(params.capability))
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} execution capability does not match its reservation.`
      )
    }
    const contextUpdate = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?,
             capability_hash = ?, launch_token_hash = COALESCE(launch_token_hash, ?),
             capability_revoked_at = NULL
         WHERE id = ? AND status = 'pending'`
      )
      .run(
        params.handle,
        params.paneKey,
        params.processIncarnation,
        hashDispatchCapability(capability),
        params.launchTokenHash ?? null,
        params.dispatchId
      )
    if (contextUpdate.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    const workerUpdate = this.db
      .prepare(
        `UPDATE worker_dispatches
         SET stage = 'authority_attached', worktree_id = ?, agent_terminal_handle = ?,
             provisional_capability = NULL,
             setup_state = ?, effects = ?, residual_resources = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(
        params.worktreeId,
        params.handle,
        params.setupState,
        JSON.stringify(params.effects),
        JSON.stringify(
          params.effects.filter((effect) =>
            Boolean(
              effect &&
              typeof effect === 'object' &&
              ((effect as { action?: string }).action?.startsWith('created') ||
                (effect as { action?: string }).action === 'reused_agent_terminal')
            )
          )
        ),
        params.dispatchId
      )
    if (workerUpdate.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    if (params.terminalOwnership && !this.getWorkerTerminalResourceByOwner(params.dispatchId)) {
      if (params.terminalOwnership === 'created') {
        this.createWorkerTerminalResourceStatement({
          dispatchId: params.dispatchId,
          worktreeId: params.worktreeId,
          terminalHandle: params.handle,
          paneKey: params.paneKey,
          processIncarnation: params.processIncarnation,
          hostScope: params.hostScope,
          lifecycleState: 'owned'
        })
      } else {
        const transferable = this.findTransferableWorkerTerminalResource({
          terminalHandle: params.handle,
          paneKey: params.paneKey,
          processIncarnation: params.processIncarnation,
          hostScope: params.hostScope ?? null
        })
        if (transferable) {
          this.transferWorkerTerminalResourceStatement({
            resourceId: transferable.id,
            toDispatchId: params.dispatchId,
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope ?? null
          })
        } else {
          this.createWorkerTerminalResourceStatement({
            dispatchId: params.dispatchId,
            worktreeId: params.worktreeId,
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope,
            lifecycleState: 'external'
          })
        }
      }
    }
    if (params.generationOperation) {
      const completed = this.db
        .prepare(
          `UPDATE worker_generation_operations
              SET state = 'completed', receipt = ?, updated_at = datetime('now')
            WHERE dispatch_id = ? AND effect_kind = 'execution_start' AND operation_id = ?
              AND payload_fingerprint = ? AND claimant_id = ? AND state = 'claimed'`
        )
        .run(
          JSON.stringify(params.generationOperation.receipt),
          params.dispatchId,
          params.generationOperation.operationId,
          params.generationOperation.payloadFingerprint,
          params.generationOperation.claimantId
        )
      if (completed.changes !== 1) {
        throw new OrchestrationError(
          'operation_unknown',
          `Worker generation authority for ${params.dispatchId} could not settle atomically.`
        )
      }
    }
    this.db.exec('COMMIT')
    return capability
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function reserveStartingWorkerCapability(this: OrchestrationDb, dispatchId: string): string {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const worker = this.getWorkerDispatch(dispatchId)
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!worker || worker.state !== 'starting' || !dispatch || dispatch.status !== 'pending') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    if (worker.provisional_capability) {
      this.db.exec('COMMIT')
      return worker.provisional_capability
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    const updated = this.db
      .prepare(
        `UPDATE worker_dispatches
            SET provisional_capability = ?, updated_at = datetime('now')
          WHERE dispatch_id = ? AND state = 'starting' AND provisional_capability IS NULL`
      )
      .run(capability, dispatchId)
    if (updated.changes !== 1) {
      throw new OrchestrationError(
        'operation_unknown',
        `Dispatch ${dispatchId} capability changed.`
      )
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
            SET capability_hash = ?, capability_revoked_at = NULL
          WHERE id = ? AND status = 'pending'`
      )
      .run(hashDispatchCapability(capability), dispatchId)
    this.db.exec('COMMIT')
    return capability
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchAuthorityMethods = {
  prepareStartingWorkerAuthority: typeof prepareStartingWorkerAuthority
  reserveStartingWorkerCapability: typeof reserveStartingWorkerCapability
}

export function attachWorkerDispatchAuthority(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    prepareStartingWorkerAuthority,
    reserveStartingWorkerCapability
  })
}
