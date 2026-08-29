import type { DispatchContextRow, TaskRow, WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import { CURRENT_CONTRACT_VERSION } from '../contract-constants'
import { generateId } from '../generated-id'
import { hashDispatchCapability } from '../dispatch-capability-hash'
import type { OrchestrationDb } from '../orchestration-db'
import { insertStartingDispatchContextRow } from '../dispatch-row-writer'
import type { DispatchCreator } from '../dispatch-depth'

type StartingWorkerFederation = {
  environmentId: string
  environmentName: string
  peerFingerprint: string
  protocolVersion: number
}

export function insertStartingWorkerDispatchStatement(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    task: TaskRow
    startOptions: unknown
    launchTokenHash?: string
    runtimeEpoch?: string
    provisionalCapability?: string
    federation?: StartingWorkerFederation
    depth: number
  }
): { dispatch: DispatchContextRow; worker: WorkerDispatchRow } {
  insertStartingDispatchContextRow(this.db, {
    id: params.dispatchId,
    runId: params.task.run_id,
    taskId: params.task.id,
    contractVersion: CURRENT_CONTRACT_VERSION,
    launchTokenHash: params.launchTokenHash ?? null,
    depth: params.depth
  })
  this.db
    .prepare(
      `INSERT INTO worker_dispatches (
         dispatch_id, runtime_epoch, state, stage, start_options, provisional_capability
       ) VALUES (?, ?, 'starting', 'accepted', ?, ?)`
    )
    .run(
      params.dispatchId,
      params.runtimeEpoch ?? null,
      JSON.stringify(params.startOptions),
      params.provisionalCapability ?? null
    )
  if (params.provisionalCapability) {
    this.db
      .prepare(
        `UPDATE dispatch_contexts
            SET capability_hash = ?, capability_revoked_at = NULL
          WHERE id = ? AND status = 'pending'`
      )
      .run(hashDispatchCapability(params.provisionalCapability), params.dispatchId)
  }
  if (params.federation) {
    this.db
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        params.dispatchId,
        params.federation.environmentId,
        params.federation.environmentName,
        params.federation.peerFingerprint,
        params.federation.protocolVersion
      )
  }
  this.db
    .prepare(
      "UPDATE tasks SET status = 'dispatched', result = NULL, completed_at = NULL WHERE id = ?"
    )
    .run(params.task.id)
  return {
    dispatch: this.getDispatchContextById(params.dispatchId) as DispatchContextRow,
    worker: this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
  }
}

export function createStartingWorkerDispatch(
  this: OrchestrationDb,
  params: {
    taskId: string
    dispatchId?: string
    provisionalCapability?: string
    startOptions: unknown
    launchTokenHash?: string
    retryOf?: string
    runtimeEpoch?: string
    federation?: StartingWorkerFederation
    mutationReceipt?: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
    /** Who is dispatching, for nesting depth. Required so a new caller must decide. */
    creator: DispatchCreator
    maxDepth: number
  }
): { dispatch: DispatchContextRow; worker: WorkerDispatchRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.mutationReceipt) {
      const receipt = params.mutationReceipt
      const existing = this.getMutationReceipt(receipt.callerFingerprint, receipt.requestId)
      if (existing) {
        if (existing.method !== receipt.method || existing.payload_hash !== receipt.payloadHash) {
          throw new OrchestrationError(
            'request_mismatch',
            `Mutation request ${receipt.requestId} was already used with different input.`
          )
        }
        throw new OrchestrationError(
          'operation_unknown',
          `Mutation ${receipt.requestId} already has a durable acceptance record.`
        )
      }
      ensureMutationReceiptCapacity(this.db)
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             caller_fingerprint, request_id, method, payload_hash, state
           ) VALUES (?, ?, ?, ?, 'pending')`
        )
        .run(receipt.callerFingerprint, receipt.requestId, receipt.method, receipt.payloadHash)
    }
    const task = this.getTask(params.taskId)
    if (!task) {
      throw new OrchestrationError('task_not_found', `Task ${params.taskId} was not found.`)
    }
    const unsettledResource = this.db
      .prepare(
        `SELECT r.id, r.lifecycle_state
           FROM worker_execution_resources r
           JOIN dispatch_contexts d ON d.id = r.owner_dispatch_id
          WHERE d.task_id = ?
            AND r.lifecycle_state IN (
              'owned', 'retained', 'release_requested', 'release_closing', 'release_unknown'
            )
          LIMIT 1`
      )
      .get(task.id) as { id: string; lifecycle_state: string } | undefined
    if (unsettledResource) {
      throw new OrchestrationError(
        'terminal_resource_unsettled',
        `Task ${task.id} cannot start while terminal resource ${unsettledResource.id} is ${unsettledResource.lifecycle_state}.`
      )
    }
    if (params.retryOf) {
      const prior = this.getDispatchContextById(params.retryOf)
      const priorWorker = this.getWorkerDispatch(params.retryOf)
      const latest = this.getDispatchContext(task.id)
      if (
        !prior ||
        prior.task_id !== task.id ||
        latest?.id !== prior.id ||
        !priorWorker ||
        !['failed', 'stopped', 'abandoned'].includes(priorWorker.state) ||
        !['failed', 'blocked'].includes(task.status)
      ) {
        throw new OrchestrationError(
          'task_not_startable',
          `Task ${task.id} cannot retry from Dispatch ${params.retryOf}.`
        )
      }
    } else if (task.status !== 'ready') {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${task.id} is ${task.status}; only a ready Task can start.`
      )
    }

    const id = params.dispatchId ?? generateId('ctx')
    if (params.mutationReceipt) {
      this.db
        .prepare(
          `UPDATE mutation_receipts
           SET receipt = ?, updated_at = datetime('now')
           WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
        )
        .run(
          JSON.stringify({ accepted: { dispatchId: id } }),
          params.mutationReceipt.callerFingerprint,
          params.mutationReceipt.requestId
        )
    }
    const started = insertStartingWorkerDispatchStatement.call(this, {
      dispatchId: id,
      task,
      startOptions: params.startOptions,
      launchTokenHash: params.launchTokenHash,
      runtimeEpoch: params.runtimeEpoch,
      provisionalCapability: params.provisionalCapability,
      federation: params.federation,
      depth: this.resolveChildDispatchDepth(params.creator, params.maxDepth)
    })
    this.db.exec('COMMIT')
    this.hasAnyDispatchContextsCache = true
    return started
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchStartMethods = {
  createStartingWorkerDispatch: typeof createStartingWorkerDispatch
}

export function attachWorkerDispatchStart(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createStartingWorkerDispatch
  })
}
