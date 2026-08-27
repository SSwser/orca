import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function markWorkerDispatchReady(
  this: OrchestrationDb,
  dispatchId: string,
  effects?: unknown[]
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    this.db
      .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
      .run(dispatchId)
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'ready', stage = 'input_accepted',
             effects = COALESCE(?, effects), updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(effects ? JSON.stringify(effects) : null, dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

function failWorkerStartFromState(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  expectedState: 'starting' | 'start_unknown',
  // Why (#16095): revocation exists to stop a worker acting on a dispatch that never landed. A
  // prompt whose turn start went unobserved provably landed, so its worker keeps the authority its
  // own report needs.
  options: { retainCapability?: boolean } = {}
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== expectedState) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is not ${expectedState}.`
      )
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
             capability_revoked_at = CASE WHEN ? = 1 THEN capability_revoked_at
               ELSE COALESCE(capability_revoked_at, datetime('now')) END
         WHERE id = ?`
      )
      .run(reason, options.retainCapability ? 1 : 0, dispatchId)
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'failed', stage = ?, last_error = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(stage, reason, dispatchId)
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', completed_at = datetime('now')
         WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM dispatch_contexts
           WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
         )`
      )
      .run(dispatch.task_id)
    this.closeQuestionsForDispatch(dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function markWorkerStartUnknown(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'start_unknown', stage = ?, last_error = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(stage, reason, dispatchId)
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(dispatchId)
    this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
    this.closeQuestionsForDispatch(dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function failWorkerStart(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  options: { retainCapability?: boolean } = {}
): WorkerDispatchRow {
  return failWorkerStartFromState.call(this, dispatchId, stage, reason, 'starting', options)
}

export function failWorkerStartReconciliation(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string
): WorkerDispatchRow {
  return failWorkerStartFromState.call(this, dispatchId, stage, reason, 'start_unknown')
}

export function resumeWorkerStartUnknown(
  this: OrchestrationDb,
  dispatchId: string
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'start_unknown') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is not awaiting exact start reconciliation.`
      )
    }
    const resumed = this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'starting', last_error = NULL, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'start_unknown'`
      )
      .run(dispatchId)
    if (resumed.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is not awaiting exact start reconciliation.`
      )
    }
    this.db
      .prepare('UPDATE dispatch_contexts SET capability_revoked_at = NULL WHERE id = ?')
      .run(dispatchId)
    this.db.prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ?").run(dispatch.task_id)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getWorkerDispatch(
  this: OrchestrationDb,
  dispatchId: string
): WorkerDispatchRow | undefined {
  return this.db
    .prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as WorkerDispatchRow | undefined
}

export type WorkerDispatchOutcomeMethods = {
  markWorkerDispatchReady: typeof markWorkerDispatchReady
  failWorkerStart: typeof failWorkerStart
  failWorkerStartReconciliation: typeof failWorkerStartReconciliation
  markWorkerStartUnknown: typeof markWorkerStartUnknown
  resumeWorkerStartUnknown: typeof resumeWorkerStartUnknown
  getWorkerDispatch: typeof getWorkerDispatch
}

export function attachWorkerDispatchOutcome(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    markWorkerDispatchReady,
    failWorkerStart,
    failWorkerStartReconciliation,
    markWorkerStartUnknown,
    resumeWorkerStartUnknown,
    getWorkerDispatch
  })
}
