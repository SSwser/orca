import type { DeliveryRow, DispatchContextRow, TaskRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { parseWorkerTerminalHostScope } from '../../worker-terminal-process-liveness'
import { isEquivalentPaneKey } from '../pane-key-match'
import { deliveryContainsWorkerSettlementForResource } from '../runs/run-delivery-worker-settlement'
import type { OrchestrationDb } from '../orchestration-db'
import type { LostCustodyRecoveryParams } from './worker-terminal-containment-recovery'

export function validateRecoveryAuthority(
  db: OrchestrationDb,
  params: LostCustodyRecoveryParams
): {
  task: TaskRow
  source: DispatchContextRow
  resource: NonNullable<ReturnType<OrchestrationDb['getWorkerTerminalResource']>>
  delivery: DeliveryRow
  sourceWorktreeId: string
} {
  const run = db.requireCurrentConsumer(params.runId, params.consumerGeneration)
  if (
    run.coordinator_handle !== params.coordinatorHandle ||
    !run.coordinator_pane_key ||
    !isEquivalentPaneKey(run.coordinator_pane_key, params.coordinatorPaneKey)
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'worker-recover requires the coordinator terminal currently bound to the Run.'
    )
  }
  const source = db.getDispatchContextById(params.sourceDispatchId)
  const worker = db.getWorkerDispatch(params.sourceDispatchId)
  const task = source ? db.getTask(source.task_id) : undefined
  if (
    !source ||
    !worker ||
    !task ||
    source.run_id !== run.id ||
    task.run_id !== run.id ||
    db.getDispatchContext(task.id)?.id !== source.id ||
    !['completed', 'failed'].includes(source.status) ||
    !['succeeded', 'failed', 'abandoned'].includes(worker.state)
  ) {
    throw new OrchestrationError(
      'task_not_startable',
      `Dispatch ${params.sourceDispatchId} is not the current settled worker for its Task.`
    )
  }
  if (db.getFederatedDispatch(source.id)) {
    throw new OrchestrationError(
      'federation_unsupported',
      'Paired and federated workers cannot be recovered without execution-host containment support.'
    )
  }
  const resource = db.getWorkerTerminalResource(params.sourceResourceId)
  if (
    !resource ||
    resource.owner_dispatch_id !== source.id ||
    resource.lifecycle_state !== 'release_unknown' ||
    !resource.process_incarnation ||
    !resource.host_scope ||
    !resource.worktree_id ||
    worker.worktree_id !== resource.worktree_id ||
    worker.agent_terminal_handle !== resource.terminal_handle
  ) {
    throw new OrchestrationError(
      'terminal_resource_unsettled',
      'worker-recover requires the exact release_unknown resource owned by the source Dispatch.'
    )
  }
  const hostScope = parseWorkerTerminalHostScope(resource.host_scope)
  if (hostScope?.kind !== 'local' || !hostScope.restartCustody) {
    throw new OrchestrationError(
      'federation_unsupported',
      'Worker recovery requires exact local restart custody; SSH, paired, federated, and legacy no-custody resources fail closed.'
    )
  }
  const delivery = db.getDeliveryRaw(params.sourceDeliveryId)
  if (
    !delivery ||
    delivery.run_id !== run.id ||
    delivery.consumer_generation !== run.consumer_generation ||
    delivery.status !== 'outstanding' ||
    !deliveryContainsWorkerSettlementForResource(db, delivery, source.id, resource.id)
  ) {
    throw new OrchestrationError(
      'stale_delivery',
      'worker-recover requires the current outstanding Delivery containing the source settlement.'
    )
  }
  return { task, source, resource, delivery, sourceWorktreeId: resource.worktree_id }
}
