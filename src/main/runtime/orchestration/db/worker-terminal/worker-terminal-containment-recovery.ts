import type {
  DeliveryRow,
  DispatchContextRow,
  WorkerDispatchRow,
  WorkerLostCustodyRecoveryRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

type RecoveryMutationReceipt = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

type LostCustodyRecoveryBaseParams = {
  runId: string
  consumerGeneration: number
  coordinatorHandle: string
  coordinatorPaneKey: string
  sourceDispatchId: string
  sourceResourceId: string
  sourceDeliveryId: string
  mutationReceipt: RecoveryMutationReceipt
}

export type LostCustodyRecoveryParams = LostCustodyRecoveryBaseParams &
  (
    | {
        recoveryDisposition: 'accept_archived_result'
        authorization: 'accept_authoritative_archived_result_with_lost_custody'
      }
    | {
        recoveryDisposition: 'retry_with_successor'
        trustedRevision: string
        successorPlacement: 'new-child' | 'new-top-level'
        successorName: string
        authorization: 'acknowledge_possible_duplicate_external_effects'
        startOptions: unknown
        runtimeEpoch?: string
      }
  )

type LostCustodyRecoveryResultBase = {
  disposition: 'accepted' | 'replayed'
  processAction: 'none'
  recovery: WorkerLostCustodyRecoveryRow
  delivery: DeliveryRow
}

export type LostCustodyArchiveAcceptanceResult = LostCustodyRecoveryResultBase & {
  successor: null
}

export type LostCustodySuccessorRecoveryResult = LostCustodyRecoveryResultBase & {
  successor: { dispatch: DispatchContextRow; worker: WorkerDispatchRow }
}

export type LostCustodyRecoveryResult =
  | LostCustodyArchiveAcceptanceResult
  | LostCustodySuccessorRecoveryResult

export function lostCustodyRecoveryReceipt(
  recoveryId: string,
  params: LostCustodyRecoveryParams,
  successorDispatchId: string | null
): string {
  return JSON.stringify({
    accepted: {
      recoveryId,
      sourceDispatchId: params.sourceDispatchId,
      successorDispatchId,
      recoveryDisposition: params.recoveryDisposition,
      processAction: 'none'
    }
  })
}

export function getLostCustodyRecoveryByMutation(
  db: OrchestrationDb,
  callerFingerprint: string,
  requestId: string
): WorkerLostCustodyRecoveryRow | undefined {
  return db.db
    .prepare(
      `SELECT * FROM worker_lost_custody_recoveries
        WHERE mutation_caller_fingerprint = ? AND mutation_request_id = ?`
    )
    .get(callerFingerprint, requestId) as WorkerLostCustodyRecoveryRow | undefined
}

export function getLostCustodyRecoveryById(
  db: OrchestrationDb,
  recoveryId: string
): WorkerLostCustodyRecoveryRow | undefined {
  return db.db
    .prepare('SELECT * FROM worker_lost_custody_recoveries WHERE id = ?')
    .get(recoveryId) as WorkerLostCustodyRecoveryRow | undefined
}

export function exposeLostCustodyRecoveryResult(
  db: OrchestrationDb,
  recovery: WorkerLostCustodyRecoveryRow,
  disposition: 'accepted' | 'replayed'
): LostCustodyRecoveryResult {
  const delivery = db.getDeliveryRaw(recovery.source_delivery_id)
  if (!delivery) {
    throw new OrchestrationError(
      'operation_unknown',
      `Recovery ${recovery.id} is missing its durable Delivery.`
    )
  }
  if (recovery.disposition === 'accept_archived_result') {
    return { disposition, processAction: 'none', recovery, successor: null, delivery }
  }
  if (!recovery.successor_dispatch_id) {
    throw new OrchestrationError(
      'operation_unknown',
      `Recovery ${recovery.id} is missing its durable successor.`
    )
  }
  const dispatch = db.getDispatchContextById(recovery.successor_dispatch_id)
  const worker = db.getWorkerDispatch(recovery.successor_dispatch_id)
  if (!dispatch || !worker) {
    throw new OrchestrationError(
      'operation_unknown',
      `Recovery ${recovery.id} is missing its durable successor.`
    )
  }
  return { disposition, processAction: 'none', recovery, successor: { dispatch, worker }, delivery }
}

export function settleContainedWorkerTerminalExit(
  this: OrchestrationDb,
  params: {
    resourceId: string
    sourceDispatchId: string
    processIncarnation: string
    hostScope: string
  }
):
  | { disposition: 'released'; processAction: 'none' }
  | { disposition: 'already_released'; processAction: 'none' }
  | { disposition: 'retained'; processAction: 'none' } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (
      resource?.lifecycle_state === 'released' &&
      resource.owner_dispatch_id === params.sourceDispatchId
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'already_released', processAction: 'none' }
    }
    if (
      !resource ||
      resource.lifecycle_state !== 'contained' ||
      resource.owner_dispatch_id !== params.sourceDispatchId ||
      resource.process_incarnation !== params.processIncarnation ||
      resource.host_scope !== params.hostScope
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'retained', processAction: 'none' }
    }
    const released = this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET lifecycle_state = 'released', retained_reason = NULL, release_error = NULL,
             release_completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND lifecycle_state = 'contained'`
      )
      .run(resource.id)
    const debt = this.db
      .prepare(
        `UPDATE worker_terminal_capacity_debts
         SET state = 'released', released_at = datetime('now')
         WHERE resource_id = ? AND state = 'withheld'`
      )
      .run(resource.id)
    if (released.changes !== 1 || debt.changes !== 1) {
      throw new OrchestrationError(
        'operation_unknown',
        `Contained capacity debt for ${resource.id} could not settle atomically.`
      )
    }
    this.db.exec('COMMIT')
    return { disposition: 'released', processAction: 'none' }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function workerWorkspaceGenerationIsFenced(
  this: OrchestrationDb,
  worktreeId: string
): boolean {
  return Boolean(
    this.db
      .prepare('SELECT 1 FROM worker_workspace_generation_fences WHERE worktree_id = ?')
      .get(worktreeId)
  )
}

export function getWorkerTerminalContainment(
  this: OrchestrationDb,
  resourceId: string
):
  | {
      recovery: WorkerLostCustodyRecoveryRow
      capacityState: 'withheld' | 'released'
      capacityReleasedAt: string | null
    }
  | undefined {
  const row = this.db
    .prepare(
      `SELECT r.*, d.state AS capacity_state, d.released_at AS capacity_released_at
         FROM worker_lost_custody_recoveries r
         JOIN worker_terminal_capacity_debts d ON d.recovery_id = r.id
        WHERE r.source_resource_id = ?`
    )
    .get(resourceId) as
    | (WorkerLostCustodyRecoveryRow & {
        capacity_state: 'withheld' | 'released'
        capacity_released_at: string | null
      })
    | undefined
  if (!row) {
    return undefined
  }
  const { capacity_state, capacity_released_at, ...recovery } = row
  return {
    recovery,
    capacityState: capacity_state,
    capacityReleasedAt: capacity_released_at
  }
}

export type WorkerTerminalContainmentRecoveryMethods = {
  settleContainedWorkerTerminalExit: typeof settleContainedWorkerTerminalExit
  workerWorkspaceGenerationIsFenced: typeof workerWorkspaceGenerationIsFenced
  getWorkerTerminalContainment: typeof getWorkerTerminalContainment
}

export function attachWorkerTerminalContainmentRecovery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    settleContainedWorkerTerminalExit,
    workerWorkspaceGenerationIsFenced,
    getWorkerTerminalContainment
  })
}
