import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { resolveOrchestrationCaller } from './orchestration-run-scope'
import { executeAcceptedLocalWorkerStart } from './orchestration-worker-start-executor'
import { prepareWorkerExecutionAdmission } from './orchestration-worker-execution-admission'
import { prepareLocalWorkerExecution } from './orchestration-worker-start-preparation'
import { WorkerStartParams } from './orchestration-worker-start-schema'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (
      params,
      {
        runtime,
        orchestrationMutation,
        orchestrationCompatibilityEvidence,
        resumedWorkerStartDispatchId,
        deferMutationCompletion
      }
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
        throw new OrchestrationError(
          'execution_host_unavailable',
          'Federated Worker execution start is unavailable until the remote host advertises the complete atomic Session start and release authority contract.'
        )
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
      if (resumedWorkerStartDispatchId) {
        const dispatch = db.getDispatchContextById(resumedWorkerStartDispatchId)
        const worker = db.getWorkerDispatch(resumedWorkerStartDispatchId)
        if (
          !dispatch ||
          dispatch.task_id !== task.id ||
          !worker ||
          !['starting', 'start_unknown'].includes(worker.state) ||
          !worker.provisional_capability ||
          !dispatch.launch_token_hash
        ) {
          throw new OrchestrationError(
            'operation_unknown',
            `Accepted Worker Dispatch ${resumedWorkerStartDispatchId} cannot be resumed safely.`
          )
        }
        const storedStartOptions = JSON.parse(worker.start_options) as Record<string, unknown>
        const { executionTargetFingerprint, ...topologyStartOptions } = storedStartOptions
        const resumedAdmission = prepareWorkerExecutionAdmission({
          runtime,
          task,
          coordinatorHandle: params.from,
          startOptions: topologyStartOptions,
          launchPreferences: prepared.launch.preferences,
          devMode: params.devMode,
          identity: {
            dispatchId: dispatch.id,
            provisionalCapability: worker.provisional_capability
          }
        })
        if (
          executionTargetFingerprint !== resumedAdmission.startOptions.executionTargetFingerprint ||
          dispatch.launch_token_hash !== resumedAdmission.launchTokenHash
        ) {
          throw new OrchestrationError(
            'operation_unknown',
            `Accepted Worker Dispatch ${dispatch.id} no longer matches its execution admission.`
          )
        }
        prepared.startOptions = storedStartOptions
        return settleWorkerStartMutation(
          executeAcceptedLocalWorkerStart({
            runtime,
            db,
            runId: run.id,
            task,
            started: { dispatch, worker },
            prepared
          }),
          deferMutationCompletion
        )
      }
      const admission = prepareWorkerExecutionAdmission({
        runtime,
        task,
        coordinatorHandle: params.from,
        startOptions: prepared.startOptions,
        launchPreferences: prepared.launch.preferences,
        devMode: params.devMode
      })
      prepared.startOptions = admission.startOptions
      const started = db.createStartingWorkerDispatch({
        creator: resolveDispatchCreator(runtime, params.from),
        maxDepth: runtime.getNestedWorkerMaxDepth(),
        taskId: task.id,
        dispatchId: admission.dispatchId,
        provisionalCapability: admission.provisionalCapability,
        launchTokenHash: admission.launchTokenHash,
        retryOf: params.retryOf,
        startOptions: prepared.startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      return settleWorkerStartMutation(
        executeAcceptedLocalWorkerStart({
          runtime,
          db,
          runId: run.id,
          task,
          started,
          prepared
        }),
        deferMutationCompletion
      )
    }
  })
]

async function settleWorkerStartMutation(
  pending: Promise<unknown>,
  deferMutationCompletion?: () => void
): Promise<unknown> {
  const result = await pending
  const state =
    result && typeof result === 'object' ? (result as { state?: unknown }).state : undefined
  if (state === 'starting' || state === 'outcome_unknown') {
    deferMutationCompletion?.()
  }
  return result
}
