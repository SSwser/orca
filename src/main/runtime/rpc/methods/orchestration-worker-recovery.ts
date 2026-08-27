import { z } from 'zod'
import {
  LOST_CUSTODY_ARCHIVE_ACCEPTANCE_AUTHORIZATION,
  LOST_CUSTODY_RECOVERY_AUTHORIZATION
} from '../../orchestration/db/worker-terminal/worker-terminal-containment-acceptance'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcContext, type RpcHandler, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { executeAcceptedLocalWorkerStart } from './orchestration-worker-start-executor'
import { prepareLocalWorkerExecution } from './orchestration-worker-start-preparation'
import { OptionalWorkerLaunchPreference } from './orchestration-worker-start-schema'

const WorkerRecoverCommonParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  resource: requiredString('Missing --resource'),
  delivery: requiredString('Missing --delivery'),
  run: OptionalString,
  from: requiredString('Missing --from'),
  devMode: z.boolean().optional()
})

const WorkerRecoverParams = z.discriminatedUnion('resolution', [
  WorkerRecoverCommonParams.extend({
    resolution: z.literal('accept_archived_result'),
    authorization: z.literal(LOST_CUSTODY_ARCHIVE_ACCEPTANCE_AUTHORIZATION)
  }),
  WorkerRecoverCommonParams.extend({
    resolution: z.literal('retry_with_successor'),
    revision: requiredString('Missing --revision'),
    worktree: z.enum(['new-child', 'new-top-level']),
    name: requiredString('Missing --name'),
    repo: OptionalString,
    displayName: OptionalString,
    comment: OptionalString,
    setup: z.enum(['run', 'skip', 'inherit']).optional(),
    agent: requiredString('Missing --agent'),
    model: OptionalWorkerLaunchPreference,
    effort: OptionalWorkerLaunchPreference,
    timeoutMs: OptionalFiniteNumber,
    authorization: z.literal(LOST_CUSTODY_RECOVERY_AUTHORIZATION)
  })
])

function replayedSuccessorReceipt(args: {
  runId: string
  taskId: string
  dispatchId: string
  state: string
  stage: string
  effects: string
  residualResources: string
  recoveryId: string
}) {
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state:
      args.state === 'ready' ? 'ready' : args.state === 'failed' ? 'failed' : 'outcome_unknown',
    stage: args.stage,
    processAction: 'none' as const,
    containment: {
      recoveryId: args.recoveryId,
      deliveryResolution: 'contained' as const,
      capacity: 'withheld' as const
    },
    effects: JSON.parse(args.effects) as unknown[],
    residualResources: JSON.parse(args.residualResources) as unknown[]
  }
}

export const ORCHESTRATION_WORKER_RECOVERY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerRecover',
    params: WorkerRecoverParams,
    handler: withWorkerRecoveryFinality(async (params, { runtime, orchestrationMutation }) => {
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'worker-recover requires a durable --retry-request identifier.'
        )
      }
      const db = runtime.getOrchestrationDb()
      const coordinatorPaneKey = runtime.getTerminalPaneKey(params.from)
      if (!coordinatorPaneKey) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-recover requires the coordinator terminal currently bound to the Run.'
        )
      }
      const run = db.getCurrentRunForPane(coordinatorPaneKey)
      if (!run || (params.run && params.run !== run.id)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-recover requires the coordinator terminal currently bound to the Run.'
        )
      }
      const source = db.getDispatchContextById(params.dispatch)
      const task = source ? db.getTask(source.task_id) : undefined
      if (!source || !task || source.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Dispatch ${params.dispatch} was not found in Run ${run.id}.`
        )
      }
      if (params.resolution === 'accept_archived_result') {
        const accepted = db.acceptLostCustodyWorkerRecovery({
          runId: run.id,
          consumerGeneration: run.consumer_generation,
          coordinatorHandle: params.from,
          coordinatorPaneKey,
          sourceDispatchId: params.dispatch,
          sourceResourceId: params.resource,
          sourceDeliveryId: params.delivery,
          recoveryDisposition: params.resolution,
          authorization: params.authorization,
          mutationReceipt: orchestrationMutation
        })
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId: source.id,
          state: 'contained',
          processAction: 'none' as const,
          recoveryDisposition: accepted.recovery.disposition,
          recoveryId: accepted.recovery.id,
          successorDispatchId: null,
          containment: {
            deliveryResolution: 'contained' as const,
            capacity: 'withheld' as const
          }
        }
      }
      const sourceResource = db.getWorkerTerminalResource(params.resource)
      const workerParams = {
        task: task.id,
        run: run.id,
        from: params.from,
        worktree: params.worktree,
        name: params.name,
        repo: params.repo,
        baseBranch: params.revision,
        displayName: params.displayName,
        comment: params.comment,
        setup: params.setup,
        agent: params.agent,
        model: params.model,
        effort: params.effort,
        timeoutMs: params.timeoutMs,
        devMode: params.devMode
      }
      const prepared = await prepareLocalWorkerExecution({ runtime, params: workerParams })
      if (
        sourceResource?.worktree_id &&
        prepared.creationWorktree?.id === sourceResource.worktree_id
      ) {
        throw new OrchestrationError(
          'terminal_resource_unsettled',
          'worker-recover cannot create a successor from the lost-custody physical workspace.'
        )
      }
      const repoSelector = params.repo ?? prepared.creationWorktree?.repoId
      if (!repoSelector) {
        throw new OrchestrationError(
          'invalid_argument',
          'worker-recover could not resolve a local Git repository for the successor.'
        )
      }
      const trustedRevision = await runtime.resolveLocalManagedRepoCommit(
        repoSelector,
        params.revision
      )
      const accepted = db.acceptLostCustodyWorkerRecovery({
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        coordinatorHandle: params.from,
        coordinatorPaneKey,
        sourceDispatchId: params.dispatch,
        sourceResourceId: params.resource,
        sourceDeliveryId: params.delivery,
        recoveryDisposition: params.resolution,
        trustedRevision,
        successorPlacement: params.worktree,
        successorName: params.name,
        authorization: params.authorization,
        startOptions: prepared.startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      if (!accepted.successor) {
        throw new OrchestrationError(
          'operation_unknown',
          `Recovery ${accepted.recovery.id} is missing its retry successor.`
        )
      }
      if (
        accepted.disposition === 'replayed' &&
        !['starting', 'start_unknown'].includes(accepted.successor.worker.state)
      ) {
        return replayedSuccessorReceipt({
          runId: run.id,
          taskId: task.id,
          dispatchId: accepted.successor.dispatch.id,
          state: accepted.successor.worker.state,
          stage: accepted.successor.worker.stage,
          effects: accepted.successor.worker.effects,
          residualResources: accepted.successor.worker.residual_resources,
          recoveryId: accepted.recovery.id
        })
      }
      const result = await executeAcceptedLocalWorkerStart({
        runtime,
        db,
        runId: run.id,
        task,
        started: accepted.successor,
        prepared
      })
      return {
        ...(result as Record<string, unknown>),
        processAction: 'none' as const,
        containment: {
          recoveryId: accepted.recovery.id,
          sourceDispatchId: params.dispatch,
          sourceResourceId: params.resource,
          deliveryResolution: 'contained' as const,
          capacity: 'withheld' as const
        }
      }
    })
  })
]

export function withWorkerRecoveryFinality<T>(handler: RpcHandler<T>): RpcHandler<T> {
  return async (params, context: RpcContext) => {
    const receipt = await handler(params, context)
    const state =
      receipt && typeof receipt === 'object' && 'state' in receipt
        ? (receipt as { state?: unknown }).state
        : undefined
    if (!['ready', 'failed', 'contained'].includes(typeof state === 'string' ? state : '')) {
      context.deferMutationCompletion?.()
    }
    return receipt
  }
}
