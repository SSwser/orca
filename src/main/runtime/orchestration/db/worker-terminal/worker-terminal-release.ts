import { WORKER_RELEASABLE_STATES, WORKER_SETTLED_STATES } from '../../worker-terminal-ownership'
import type { MessageRow } from '../../types'
import type {
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import {
  WORKER_RELEASE_UNKNOWN_MESSAGE_FROM,
  workerReleaseUnknownMessagePayload
} from '../runs/run-delivery-worker-settlement'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function requestWorkerTerminalRelease(
  this: OrchestrationDb,
  dispatchId: string
):
  | { disposition: 'requested'; resource: WorkerTerminalResourceRow }
  | { disposition: 'reconcile'; resource: WorkerTerminalResourceRow }
  | { disposition: 'reconcile_settled'; resource: WorkerTerminalResourceRow }
  | { disposition: 'reconcile_contained'; resource: WorkerTerminalResourceRow }
  | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
  | {
      disposition: 'retained'
      resource: WorkerTerminalResourceRow | null
      reason: WorkerTerminalRetainedReason
    } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (!worker) {
      if (!['completed', 'failed', 'circuit_broken'].includes(dispatch.status)) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is ${dispatch.status}; only a settled dispatch can release.`
        )
      }
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource: null, reason: 'no_owned_resource' }
    }
    if (!WORKER_SETTLED_STATES.includes(worker.state)) {
      // Why: release is post-completion cleanup only; recording intent for an unsettled or
      // uncertain worker would let recovery close a terminal the coordinator never reviewed.
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is ${worker.state}; only a settled worker can release. Use worker-stop to cancel an active worker.`
      )
    }
    const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource) {
      const transferred = this.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId)
      this.db.exec('COMMIT')
      return transferred
        ? { disposition: 'retained', resource: transferred, reason: 'ownership_transferred' }
        : { disposition: 'retained', resource: null, reason: 'no_owned_resource' }
    }
    if (resource.lifecycle_state === 'released') {
      this.db.exec('COMMIT')
      return { disposition: 'already_released', resource }
    }
    if (resource.lifecycle_state === 'external') {
      this.db.exec('COMMIT')
      return {
        disposition: 'retained',
        resource,
        reason: (resource.retained_reason as WorkerTerminalRetainedReason) ?? 'external_terminal'
      }
    }
    if (resource.lifecycle_state === 'user_owned') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: 'user_takeover' }
    }
    if (resource.lifecycle_state === 'transferred') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: 'ownership_transferred' }
    }
    if (resource.lifecycle_state === 'contained') {
      this.db.exec('COMMIT')
      return { disposition: 'reconcile_contained', resource }
    }
    if (resource.lifecycle_state === 'release_unknown') {
      // A prior close has an uncertain outcome; observe its exact process before any new action.
      this.db.exec('COMMIT')
      return { disposition: 'reconcile', resource }
    }
    if (worker.state === 'stopped' || worker.state === 'abandoned') {
      if (!resource.process_incarnation || !resource.host_scope) {
        this.db.exec('COMMIT')
        return { disposition: 'retained', resource, reason: 'identity_unproven' }
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET lifecycle_state = 'release_unknown', retained_reason = NULL,
               release_requested_at = COALESCE(release_requested_at, datetime('now')),
               release_error = 'The settled worker lost terminal custody; exact execution-host evidence is required.',
               updated_at = datetime('now')
           WHERE id = ? AND lifecycle_state IN ('owned', 'retained')`
        )
        .run(resource.id)
      this.db.exec('COMMIT')
      return {
        disposition: 'reconcile_settled',
        resource: this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
      }
    }
    if (resource.lifecycle_state === 'retained' && resource.retained_reason === 'user_requested') {
      this.db.prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?').run(dispatchId)
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET lifecycle_state = CASE
               WHEN lifecycle_state = 'release_closing' THEN 'release_closing'
               ELSE 'release_requested'
             END,
             retained_reason = NULL,
             release_requested_at = COALESCE(release_requested_at, datetime('now')),
             release_error = NULL, updated_at = datetime('now')
         WHERE id = ?
           AND lifecycle_state IN ('owned', 'retained', 'release_requested', 'release_closing')`
      )
      .run(resource.id)
    this.db.exec('COMMIT')
    return {
      disposition: 'requested',
      resource: this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function ensureWorkerTerminalReleaseUnknownMessage(
  this: OrchestrationDb,
  params: { dispatchId: string; resourceId: string }
): MessageRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (
      !dispatch ||
      !dispatch.run_id ||
      !resource ||
      resource.owner_dispatch_id !== dispatch.id ||
      resource.lifecycle_state !== 'release_unknown'
    ) {
      throw new OrchestrationError(
        'terminal_resource_unsettled',
        `Dispatch ${params.dispatchId} does not own the release_unknown resource ${params.resourceId}.`
      )
    }
    const messageId = `msg_release_unknown_${resource.id}`
    const existing = this.getMessageById(messageId)
    if (existing) {
      this.db.exec('COMMIT')
      return existing
    }
    const message = this.insertMessage({
      id: messageId,
      from: WORKER_RELEASE_UNKNOWN_MESSAGE_FROM,
      to: `run:${dispatch.run_id}`,
      subject: `Worker terminal release requires containment decision: ${dispatch.id}`,
      body: 'The worker terminal lost exact custody. No process action was taken.',
      type: 'status',
      runId: dispatch.run_id,
      payload: workerReleaseUnknownMessagePayload(dispatch.task_id, dispatch.id, resource.id)
    })
    this.db.exec('COMMIT')
    return message
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function settleDeadWorkerTerminalRelease(
  this: OrchestrationDb,
  params: {
    requestingDispatchId: string
    resourceId: string
    processIncarnation: string
  }
):
  | { disposition: 'released'; resource: WorkerTerminalResourceRow }
  | { disposition: 'retained'; resource: WorkerTerminalResourceRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Worker terminal resource ${params.resourceId} was not found.`
      )
    }
    const requester = this.getWorkerDispatch(params.requestingDispatchId)
    if (
      resource.owner_dispatch_id !== params.requestingDispatchId ||
      !requester ||
      !WORKER_SETTLED_STATES.includes(requester.state) ||
      resource.process_incarnation !== params.processIncarnation ||
      resource.lifecycle_state !== 'release_unknown'
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource }
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET lifecycle_state = 'released', retained_reason = NULL,
             release_requested_at = COALESCE(release_requested_at, datetime('now')),
             release_completed_at = datetime('now'), release_error = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND owner_dispatch_id = ? AND process_incarnation = ?
           AND lifecycle_state = 'release_unknown'`
      )
      .run(params.resourceId, params.requestingDispatchId, params.processIncarnation)
    const released = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
    this.db.exec('COMMIT')
    return released.lifecycle_state === 'released'
      ? { disposition: 'released', resource: released }
      : { disposition: 'retained', resource: released }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function resumeUnknownWorkerTerminalRelease(
  this: OrchestrationDb,
  params: { dispatchId: string; resourceId: string; processIncarnation: string }
):
  | { disposition: 'requested'; resource: WorkerTerminalResourceRow }
  | { disposition: 'retained'; resource: WorkerTerminalResourceRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Worker terminal resource ${params.resourceId} was not found.`
      )
    }
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (
      resource.owner_dispatch_id !== params.dispatchId ||
      resource.process_incarnation !== params.processIncarnation ||
      resource.lifecycle_state !== 'release_unknown' ||
      !worker ||
      !WORKER_RELEASABLE_STATES.includes(worker.state)
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource }
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET lifecycle_state = 'release_requested', release_error = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND owner_dispatch_id = ? AND process_incarnation = ?
           AND lifecycle_state = 'release_unknown'`
      )
      .run(params.resourceId, params.dispatchId, params.processIncarnation)
    const requested = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
    this.db.exec('COMMIT')
    return requested.lifecycle_state === 'release_requested'
      ? { disposition: 'requested', resource: requested }
      : { disposition: 'retained', resource: requested }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalReleaseMethods = {
  requestWorkerTerminalRelease: typeof requestWorkerTerminalRelease
  ensureWorkerTerminalReleaseUnknownMessage: typeof ensureWorkerTerminalReleaseUnknownMessage
  settleDeadWorkerTerminalRelease: typeof settleDeadWorkerTerminalRelease
  resumeUnknownWorkerTerminalRelease: typeof resumeUnknownWorkerTerminalRelease
}

export function attachWorkerTerminalRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requestWorkerTerminalRelease,
    ensureWorkerTerminalReleaseUnknownMessage,
    settleDeadWorkerTerminalRelease,
    resumeUnknownWorkerTerminalRelease
  })
}
