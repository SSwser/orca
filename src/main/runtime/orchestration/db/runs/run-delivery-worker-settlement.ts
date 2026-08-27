import type { DeliveryRow, MessageRow } from '../../types'
import { hasLifecycleRejectionMarker } from '../lifecycle-rejection-marker'
import type { OrchestrationDb } from '../orchestration-db'

export const WORKER_RELEASE_UNKNOWN_MESSAGE_FROM = 'system:worker-release'

type WorkerReleaseUnknownMessagePayload = {
  taskId: string
  dispatchId: string
  resourceId: string
  terminalSettlement: 'release_unknown'
  processAction: 'none'
}

export function workerReleaseUnknownMessagePayload(
  taskId: string,
  dispatchId: string,
  resourceId: string
): string {
  return JSON.stringify({
    taskId,
    dispatchId,
    resourceId,
    terminalSettlement: 'release_unknown',
    processAction: 'none'
  } satisfies WorkerReleaseUnknownMessagePayload)
}

function workerDoneDispatchId(message: MessageRow): string | null {
  if (
    message.type !== 'worker_done' ||
    !message.payload ||
    hasLifecycleRejectionMarker(message.payload)
  ) {
    return null
  }
  try {
    const payload = JSON.parse(message.payload) as Record<string, unknown>
    return typeof payload.dispatchId === 'string' && payload.dispatchId.length > 0
      ? payload.dispatchId
      : null
  } catch {
    return null
  }
}

function workerReleaseUnknownMarker(
  message: MessageRow
): WorkerReleaseUnknownMessagePayload | null {
  if (
    message.type !== 'status' ||
    message.from_handle !== WORKER_RELEASE_UNKNOWN_MESSAGE_FROM ||
    !message.payload
  ) {
    return null
  }
  try {
    const payload = JSON.parse(message.payload) as Partial<WorkerReleaseUnknownMessagePayload>
    return typeof payload.taskId === 'string' &&
      typeof payload.dispatchId === 'string' &&
      typeof payload.resourceId === 'string' &&
      payload.terminalSettlement === 'release_unknown' &&
      payload.processAction === 'none'
      ? (payload as WorkerReleaseUnknownMessagePayload)
      : null
  } catch {
    return null
  }
}

export function deliveryContainsWorkerDoneForDispatch(
  db: OrchestrationDb,
  delivery: DeliveryRow,
  dispatchId: string
): boolean {
  return db
    .getDeliveryMessages(delivery)
    .some((message) => workerDoneDispatchId(message) === dispatchId)
}

export function deliveryContainsWorkerSettlementForResource(
  db: OrchestrationDb,
  delivery: DeliveryRow,
  dispatchId: string,
  resourceId: string
): boolean {
  return db.getDeliveryMessages(delivery).some((message) => {
    if (workerDoneDispatchId(message) === dispatchId) {
      return true
    }
    const marker = workerReleaseUnknownMarker(message)
    return marker?.dispatchId === dispatchId && marker.resourceId === resourceId
  })
}

export function unresolvedWorkerTerminalDispatchId(
  db: OrchestrationDb,
  delivery: DeliveryRow
): string | null {
  for (const message of db.getDeliveryMessages(delivery)) {
    const dispatchId =
      workerDoneDispatchId(message) ?? workerReleaseUnknownMarker(message)?.dispatchId
    if (!dispatchId) {
      continue
    }
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    if (
      resource &&
      [
        'owned',
        'retained',
        'release_requested',
        'release_closing',
        'release_unknown',
        'contained'
      ].includes(resource.lifecycle_state)
    ) {
      return dispatchId
    }
  }
  return null
}

export function finalizeWorkerTaskAfterResourceSettlement(
  db: OrchestrationDb,
  dispatchId: string
): boolean {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  const task = dispatch ? db.getTask(dispatch.task_id) : undefined
  const resource =
    db.getWorkerTerminalResourceByOwner(dispatchId) ??
    db.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId)
  const transferredAway = Boolean(
    resource &&
    resource.owner_dispatch_id !== dispatchId &&
    (JSON.parse(resource.prior_owner_dispatch_ids) as string[]).includes(dispatchId)
  )
  if (
    !dispatch ||
    !worker ||
    !task ||
    task.status !== 'dispatched' ||
    (!transferredAway && db.getDispatchContext(task.id)?.id !== dispatch.id) ||
    !['completed', 'failed'].includes(dispatch.status) ||
    !['succeeded', 'failed'].includes(worker.state) ||
    !resource
  ) {
    return false
  }
  const ordinarilySettled = ['released', 'transferred', 'user_owned', 'external'].includes(
    resource.lifecycle_state
  )
  if (!ordinarilySettled && !transferredAway) {
    return false
  }
  const status = worker.state === 'succeeded' ? 'completed' : 'failed'
  const updated = db.db
    .prepare(
      `UPDATE tasks SET status = ?, completed_at = datetime('now')
        WHERE id = ? AND status = 'dispatched'`
    )
    .run(status, task.id)
  if (updated.changes !== 1) {
    return false
  }
  if (status === 'completed') {
    db.promoteReadyTasks(task.id)
  }
  return true
}
