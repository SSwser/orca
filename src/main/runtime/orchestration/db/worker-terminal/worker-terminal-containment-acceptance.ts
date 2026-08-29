import type { DeliveryRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import { generateId } from '../generated-id'
import { finalizeWorkerTaskAfterResourceSettlement } from '../runs/run-delivery-worker-settlement'
import { insertStartingWorkerDispatchStatement } from '../worker-dispatch/worker-dispatch-start'
import type { OrchestrationDb } from '../orchestration-db'
import { validateRecoveryAuthority } from './worker-terminal-containment-authority'
import {
  exposeLostCustodyRecoveryResult,
  getLostCustodyRecoveryById,
  getLostCustodyRecoveryByMutation,
  lostCustodyRecoveryReceipt,
  type LostCustodyRecoveryParams,
  type LostCustodyArchiveAcceptanceResult,
  type LostCustodySuccessorRecoveryResult
} from './worker-terminal-containment-recovery'

export const LOST_CUSTODY_RECOVERY_AUTHORIZATION =
  'acknowledge_possible_duplicate_external_effects' as const
export const LOST_CUSTODY_ARCHIVE_ACCEPTANCE_AUTHORIZATION =
  'accept_authoritative_archived_result_with_lost_custody' as const

function recoveryIdFromReceipt(receipt: string | null): string | undefined {
  if (!receipt) {
    return undefined
  }
  const parsed = JSON.parse(receipt) as { accepted?: { recoveryId?: unknown } }
  return typeof parsed.accepted?.recoveryId === 'string' ? parsed.accepted.recoveryId : undefined
}

export function acceptLostCustodyWorkerRecovery<TParams extends LostCustodyRecoveryParams>(
  this: OrchestrationDb,
  params: TParams
): TParams extends { recoveryDisposition: 'retry_with_successor' }
  ? LostCustodySuccessorRecoveryResult
  : LostCustodyArchiveAcceptanceResult {
  const expectedAuthorization =
    params.recoveryDisposition === 'accept_archived_result'
      ? LOST_CUSTODY_ARCHIVE_ACCEPTANCE_AUTHORIZATION
      : LOST_CUSTODY_RECOVERY_AUTHORIZATION
  if (params.authorization !== expectedAuthorization) {
    throw new OrchestrationError(
      'invalid_argument',
      'worker-recover requires the explicit authorization for its selected lost-custody disposition.'
    )
  }
  if (
    params.recoveryDisposition === 'retry_with_successor' &&
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(params.trustedRevision)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'worker-recover requires an immutable 40- or 64-character Git object ID.'
    )
  }
  if (params.recoveryDisposition === 'retry_with_successor' && !params.successorName.trim()) {
    throw new OrchestrationError('invalid_argument', 'worker-recover requires a successor name.')
  }

  this.db.exec('BEGIN IMMEDIATE')
  try {
    const receipt = params.mutationReceipt
    const existingReceipt = this.getMutationReceipt(receipt.callerFingerprint, receipt.requestId)
    if (existingReceipt) {
      if (
        existingReceipt.method !== receipt.method ||
        existingReceipt.payload_hash !== receipt.payloadHash
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Mutation request ${receipt.requestId} was already used with different input.`
        )
      }
      const existingRecovery =
        getLostCustodyRecoveryByMutation(this, receipt.callerFingerprint, receipt.requestId) ??
        getLostCustodyRecoveryById(this, recoveryIdFromReceipt(existingReceipt.receipt) ?? '')
      if (!existingRecovery) {
        throw new OrchestrationError(
          'operation_unknown',
          `Mutation ${receipt.requestId} has no complete recovery receipt.`
        )
      }
      const replay = exposeLostCustodyRecoveryResult(this, existingRecovery, 'replayed')
      this.db.exec('COMMIT')
      return replay as TParams extends { recoveryDisposition: 'retry_with_successor' }
        ? LostCustodySuccessorRecoveryResult
        : LostCustodyArchiveAcceptanceResult
    }

    const convergedRecovery = this.db
      .prepare('SELECT * FROM worker_lost_custody_recoveries WHERE source_resource_id = ?')
      .get(params.sourceResourceId) as ReturnType<typeof getLostCustodyRecoveryById> | undefined
    if (convergedRecovery) {
      const originalReceipt = this.getMutationReceipt(
        convergedRecovery.mutation_caller_fingerprint,
        convergedRecovery.mutation_request_id
      )
      if (
        convergedRecovery.run_id !== params.runId ||
        convergedRecovery.source_dispatch_id !== params.sourceDispatchId ||
        convergedRecovery.source_delivery_id !== params.sourceDeliveryId ||
        convergedRecovery.disposition !== params.recoveryDisposition ||
        originalReceipt?.caller_fingerprint !== receipt.callerFingerprint ||
        originalReceipt.payload_hash !== receipt.payloadHash
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          'The source resource already has a different durable recovery disposition.'
        )
      }
      ensureMutationReceiptCapacity(this.db)
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             caller_fingerprint, request_id, method, payload_hash, state, receipt
           ) VALUES (?, ?, ?, ?, 'completed', ?)`
        )
        .run(
          receipt.callerFingerprint,
          receipt.requestId,
          receipt.method,
          receipt.payloadHash,
          lostCustodyRecoveryReceipt(
            convergedRecovery.id,
            params,
            convergedRecovery.successor_dispatch_id
          )
        )
      const replay = exposeLostCustodyRecoveryResult(this, convergedRecovery, 'replayed')
      this.db.exec('COMMIT')
      return replay as TParams extends { recoveryDisposition: 'retry_with_successor' }
        ? LostCustodySuccessorRecoveryResult
        : LostCustodyArchiveAcceptanceResult
    }

    const { task, source, resource, delivery, sourceWorktreeId } = validateRecoveryAuthority(
      this,
      params
    )
    if (
      params.recoveryDisposition === 'accept_archived_result' &&
      !this.getWorkerTerminalArchive(params.sourceDispatchId)
    ) {
      throw new OrchestrationError(
        'terminal_resource_unsettled',
        'Archive acceptance requires a durable authoritative worker archive.'
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

    const recoveryId = generateId('recovery')
    const successorDispatchId =
      params.recoveryDisposition === 'retry_with_successor' ? params.successorDispatchId : null
    const contained = this.db
      .prepare(
        `UPDATE worker_execution_resources
         SET lifecycle_state = 'contained', retained_reason = 'lost_custody',
             updated_at = datetime('now')
         WHERE id = ? AND owner_dispatch_id = ?
           AND lifecycle_state = 'release_unknown'`
      )
      .run(resource.id, params.sourceDispatchId)
    if (contained.changes !== 1) {
      throw new OrchestrationError(
        'terminal_resource_unsettled',
        'The source worker terminal lifecycle changed before containment was accepted.'
      )
    }
    this.db
      .prepare(
        `INSERT INTO worker_lost_custody_recoveries (
           id, run_id, task_id, source_dispatch_id, source_resource_id, source_delivery_id,
           source_worktree_id, disposition, trusted_revision, successor_dispatch_id,
           successor_placement, successor_name, authorization,
           mutation_caller_fingerprint, mutation_request_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        recoveryId,
        params.runId,
        task.id,
        params.sourceDispatchId,
        resource.id,
        delivery.id,
        sourceWorktreeId,
        params.recoveryDisposition,
        params.recoveryDisposition === 'retry_with_successor' ? params.trustedRevision : null,
        successorDispatchId,
        params.recoveryDisposition === 'retry_with_successor' ? params.successorPlacement : null,
        params.recoveryDisposition === 'retry_with_successor' ? params.successorName : null,
        params.authorization,
        receipt.callerFingerprint,
        receipt.requestId
      )
    this.db
      .prepare(
        `INSERT INTO worker_workspace_generation_fences (
           worktree_id, source_resource_id, recovery_id, reason
         ) VALUES (?, ?, ?, 'lost_custody')`
      )
      .run(sourceWorktreeId, resource.id, recoveryId)
    this.db
      .prepare(
        `INSERT INTO worker_execution_capacity_debts (resource_id, recovery_id)
         VALUES (?, ?)`
      )
      .run(resource.id, recoveryId)

    const messageIds = JSON.parse(delivery.message_ids) as string[]
    if (messageIds.length > 0) {
      this.db
        .prepare(
          `UPDATE messages SET read = 1 WHERE id IN (${messageIds.map(() => '?').join(',')})`
        )
        .run(...messageIds)
    }
    const resolved = this.db
      .prepare(
        `UPDATE deliveries SET status = 'contained'
         WHERE id = ? AND status = 'outstanding' AND consumer_generation = ?`
      )
      .run(delivery.id, params.consumerGeneration)
    if (resolved.changes !== 1) {
      throw new OrchestrationError(
        'stale_delivery',
        'The source Delivery changed before containment was accepted.'
      )
    }

    const successor =
      params.recoveryDisposition === 'retry_with_successor'
        ? insertStartingWorkerDispatchStatement.call(this, {
            dispatchId: successorDispatchId as string,
            task,
            startOptions: params.startOptions,
            runtimeEpoch: params.runtimeEpoch,
            provisionalCapability: params.provisionalCapability,
            launchTokenHash: params.launchTokenHash,
            depth: source.depth
          })
        : null
    if (
      params.recoveryDisposition === 'accept_archived_result' &&
      !finalizeWorkerTaskAfterResourceSettlement(this, params.sourceDispatchId)
    ) {
      throw new OrchestrationError(
        'operation_unknown',
        `Archive acceptance could not finalize Task ${task.id} atomically.`
      )
    }
    const recovery = getLostCustodyRecoveryByMutation(
      this,
      receipt.callerFingerprint,
      receipt.requestId
    )
    if (!recovery) {
      throw new OrchestrationError('operation_unknown', `Recovery ${recoveryId} was not durable.`)
    }
    this.db
      .prepare(
        `UPDATE mutation_receipts
         SET receipt = ?, updated_at = datetime('now')
         WHERE caller_fingerprint = ? AND request_id = ? AND method = ? AND payload_hash = ?`
      )
      .run(
        lostCustodyRecoveryReceipt(recoveryId, params, successorDispatchId),
        receipt.callerFingerprint,
        receipt.requestId,
        receipt.method,
        receipt.payloadHash
      )
    const containedDelivery = this.getDeliveryRaw(delivery.id) as DeliveryRow
    this.db.exec('COMMIT')
    this.hasAnyDispatchContextsCache = true
    return {
      disposition: 'accepted',
      processAction: 'none',
      recovery,
      successor,
      delivery: containedDelivery
    } as TParams extends { recoveryDisposition: 'retry_with_successor' }
      ? LostCustodySuccessorRecoveryResult
      : LostCustodyArchiveAcceptanceResult
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalContainmentAcceptanceMethods = {
  acceptLostCustodyWorkerRecovery: typeof acceptLostCustodyWorkerRecovery
}

export function attachWorkerTerminalContainmentAcceptance(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { acceptLostCustodyWorkerRecovery })
}
