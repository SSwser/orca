import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { resolveOrchestrationCaller } from './orchestration-run-scope'
import { executeAcceptedLocalWorkerStart } from './orchestration-worker-start-executor'
import { prepareLocalWorkerExecution } from './orchestration-worker-start-preparation'
import { WorkerStartParams } from './orchestration-worker-start-schema'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence }
    ) => {
      if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
        throw new OrchestrationError(
          'invalid_argument',
          '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
        )
      }
      const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
      const db = runtime.getOrchestrationDb()
      // Why: worker-start was the only Run-scoped verb that skipped this, so a
      // declared --from could name someone else's pane and inherit their depth.
      const coordinatorPane = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const run = coordinatorPane ? db.getCurrentRunForPane(coordinatorPane) : undefined
      if (!run || (params.run && params.run !== run.id)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-start requires the coordinator terminal currently bound to the Task Run.'
        )
      }
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }
      if (params.on) {
        return startFederatedWorker({
          params,
          runtime,
          db,
          runId: run.id,
          task,
          orchestrationMutation
        })
      }
      const prepared = await prepareLocalWorkerExecution({
        runtime,
        params: { ...params, timeoutMs: readinessTimeoutMs }
      })
      const selectedWorktreeId = prepared.resolvedWorktree?.id ?? prepared.creationWorktree?.id
      if (selectedWorktreeId && db.workerWorkspaceGenerationIsFenced(selectedWorktreeId)) {
        throw new OrchestrationError(
          'terminal_resource_unsettled',
          'The selected physical workspace generation is fenced by a contained worker.'
        )
      }
      const started = db.createStartingWorkerDispatch({
        creator: resolveDispatchCreator(runtime, params.from),
        maxDepth: runtime.getNestedWorkerMaxDepth(),
        taskId: task.id,
        retryOf: params.retryOf,
        startOptions: prepared.startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      return executeAcceptedLocalWorkerStart({
        runtime,
        db,
        runId: run.id,
        task,
        started,
        prepared
      })
    }
  })
]
