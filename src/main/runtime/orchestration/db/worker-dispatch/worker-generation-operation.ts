import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export type WorkerGenerationEffectKind = 'worktree' | 'execution_start'

type WorkerGenerationOperationIdentity = {
  dispatchId: string
  effectKind: WorkerGenerationEffectKind
  operationId: string
  payloadFingerprint: string
}

type WorkerGenerationOperationReadback =
  | { verdict: 'not_started' | 'conflict' | 'unverifiable' }
  | { verdict: 'completed'; receipt: unknown }

type WorkerGenerationOperationRow = {
  operation_id: string
  payload_fingerprint: string
  state: 'claimed' | 'completed' | 'unverifiable'
  claimant_id: string
  receipt: string | null
}

function readRow(
  db: OrchestrationDb,
  identity: Pick<WorkerGenerationOperationIdentity, 'dispatchId' | 'effectKind'>
): WorkerGenerationOperationRow | undefined {
  return db.db
    .prepare(
      `SELECT operation_id, payload_fingerprint, state, claimant_id, receipt
         FROM worker_generation_operations
        WHERE dispatch_id = ? AND effect_kind = ?`
    )
    .get(identity.dispatchId, identity.effectKind) as WorkerGenerationOperationRow | undefined
}

function exposeReadback(
  row: WorkerGenerationOperationRow | undefined,
  identity: WorkerGenerationOperationIdentity
): WorkerGenerationOperationReadback {
  if (!row) {
    return { verdict: 'not_started' }
  }
  if (
    row.operation_id !== identity.operationId ||
    row.payload_fingerprint !== identity.payloadFingerprint
  ) {
    return { verdict: 'conflict' }
  }
  if (row.state !== 'completed' || !row.receipt) {
    return { verdict: 'unverifiable' }
  }
  return { verdict: 'completed', receipt: JSON.parse(row.receipt) as unknown }
}

export function readWorkerGenerationOperation(
  this: OrchestrationDb,
  identity: WorkerGenerationOperationIdentity
): WorkerGenerationOperationReadback {
  return exposeReadback(readRow(this, identity), identity)
}

export function claimWorkerGenerationOperation(
  this: OrchestrationDb,
  params: WorkerGenerationOperationIdentity & { claimantId: string }
):
  | { claimed: true }
  | {
      claimed: false
      verdict: 'completed' | 'conflict' | 'unverifiable'
      receipt?: unknown
      claimantId?: string
      state?: WorkerGenerationOperationRow['state']
    } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const existing = readRow(this, params)
    if (existing) {
      const readback = exposeReadback(existing, params)
      this.db.exec('COMMIT')
      return readback.verdict === 'completed'
        ? { claimed: false, verdict: 'completed', receipt: readback.receipt }
        : {
            claimed: false,
            verdict: readback.verdict === 'not_started' ? 'unverifiable' : readback.verdict,
            claimantId: existing.claimant_id,
            state: existing.state
          }
    }
    this.db
      .prepare(
        `INSERT INTO worker_generation_operations (
           dispatch_id, effect_kind, operation_id, payload_fingerprint, claimant_id
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        params.dispatchId,
        params.effectKind,
        params.operationId,
        params.payloadFingerprint,
        params.claimantId
      )
    this.db.exec('COMMIT')
    return { claimed: true }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function reclaimWorkerGenerationOperation(
  this: OrchestrationDb,
  params: WorkerGenerationOperationIdentity & {
    expectedClaimantId: string
    claimantId: string
  }
): boolean {
  const updated = this.db
    .prepare(
      `UPDATE worker_generation_operations
          SET claimant_id = ?, updated_at = datetime('now')
        WHERE dispatch_id = ? AND effect_kind = ? AND operation_id = ?
          AND payload_fingerprint = ? AND claimant_id = ? AND state IN ('claimed', 'unverifiable')`
    )
    .run(
      params.claimantId,
      params.dispatchId,
      params.effectKind,
      params.operationId,
      params.payloadFingerprint,
      params.expectedClaimantId
    )
  return updated.changes === 1
}

export function markWorkerGenerationOperationUnverifiable(
  this: OrchestrationDb,
  params: WorkerGenerationOperationIdentity & { claimantId: string }
): boolean {
  const updated = this.db
    .prepare(
      `UPDATE worker_generation_operations
          SET state = 'unverifiable', updated_at = datetime('now')
        WHERE dispatch_id = ? AND effect_kind = ? AND operation_id = ?
          AND payload_fingerprint = ? AND claimant_id = ? AND state = 'claimed'`
    )
    .run(
      params.dispatchId,
      params.effectKind,
      params.operationId,
      params.payloadFingerprint,
      params.claimantId
    )
  return updated.changes === 1
}

export function completeWorkerGenerationOperation(
  this: OrchestrationDb,
  params: WorkerGenerationOperationIdentity & { claimantId: string; receipt: unknown }
): void {
  const updated = this.db
    .prepare(
      `UPDATE worker_generation_operations
          SET state = 'completed', receipt = ?, updated_at = datetime('now')
        WHERE dispatch_id = ? AND effect_kind = ? AND operation_id = ?
          AND payload_fingerprint = ? AND claimant_id = ? AND state IN ('claimed', 'unverifiable')`
    )
    .run(
      JSON.stringify(params.receipt),
      params.dispatchId,
      params.effectKind,
      params.operationId,
      params.payloadFingerprint,
      params.claimantId
    )
  if (updated.changes !== 1) {
    throw new OrchestrationError(
      'operation_unknown',
      `Worker generation ${params.effectKind} operation could not be completed exactly.`
    )
  }
}

export type WorkerGenerationOperationMethods = {
  readWorkerGenerationOperation: typeof readWorkerGenerationOperation
  claimWorkerGenerationOperation: typeof claimWorkerGenerationOperation
  reclaimWorkerGenerationOperation: typeof reclaimWorkerGenerationOperation
  markWorkerGenerationOperationUnverifiable: typeof markWorkerGenerationOperationUnverifiable
  completeWorkerGenerationOperation: typeof completeWorkerGenerationOperation
}

export function attachWorkerGenerationOperation(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    readWorkerGenerationOperation,
    claimWorkerGenerationOperation,
    reclaimWorkerGenerationOperation,
    markWorkerGenerationOperationUnverifiable,
    completeWorkerGenerationOperation
  })
}
