import { z } from 'zod'
import type { WorkerTerminalListState } from '../../orchestration/worker-terminal-ownership'
import { defineMethod, type RpcContext, type RpcHandler, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  exposeWorkerTerminalContainment,
  exposeWorkerTerminalResource,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-completion'
import {
  reconcileSettledWorkerTerminalRelease,
  reconcileUnknownWorkerTerminalRelease
} from './orchestration-worker-release-reconciliation'

const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'contained',
  'released'
] as const

const WorkerListParams = z.object({
  run: z.string().min(1).optional(),
  terminalState: z.enum(WORKER_TERMINAL_LIST_STATES).optional()
})

export const ORCHESTRATION_WORKER_RELEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerRelease',
    params: WorkerDispatchParams,
    handler: withWorkerReleaseFinality(async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (db.getFederatedDispatch(params.dispatch)) {
        // Fail closed: the worker server owns that terminal; a home-side close would be a guess.
        return {
          dispatchId: params.dispatch,
          state: 'retained',
          reason: 'federation_unsupported',
          processAction: 'none',
          archive: null,
          recovery:
            'Connected-server workers do not support release yet; inspect the worker server directly.'
        }
      }
      const requested = db.requestWorkerTerminalRelease(params.dispatch)
      if (requested.disposition === 'already_released') {
        return {
          dispatchId: params.dispatch,
          state: 'already_released',
          processAction: 'none',
          archive: archiveSummary(requested.resource)
        }
      }
      if (requested.disposition === 'reconcile_contained') {
        const resource = requested.resource
        const processIncarnation = resource.process_incarnation
        const hostScope = resource.host_scope
        const liveness =
          processIncarnation && hostScope
            ? await runtime.inspectTerminalProcessIncarnationLiveness(processIncarnation, hostScope)
            : 'unverifiable'
        if (processIncarnation && hostScope && liveness === 'exited') {
          const settled = db.settleContainedWorkerTerminalExit({
            resourceId: resource.id,
            sourceDispatchId: params.dispatch,
            processIncarnation,
            hostScope
          })
          if (settled.disposition === 'released') {
            runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
            return {
              dispatchId: params.dispatch,
              state: 'released',
              processAction: 'none',
              archive: archiveSummary(db.getWorkerTerminalResource(resource.id) ?? null)
            }
          }
          if (settled.disposition === 'already_released') {
            return {
              dispatchId: params.dispatch,
              state: 'already_released',
              processAction: 'none',
              archive: archiveSummary(db.getWorkerTerminalResource(resource.id) ?? null)
            }
          }
        }
        return {
          dispatchId: params.dispatch,
          state: 'contained',
          reason: 'lost_custody',
          processAction: 'none',
          archive: archiveSummary(resource),
          recovery:
            liveness === 'live'
              ? 'The exact recorded process remains live under lost custody; no process action was taken and capacity remains withheld.'
              : liveness === 'exited'
                ? 'Exact exit was observed, but the contained resource identity changed; no process action was taken and capacity remains withheld.'
                : 'The exact recorded process is unverifiable; no process action was taken and capacity remains withheld.'
        }
      }
      if (requested.disposition === 'reconcile_settled') {
        return reconcileSettledWorkerTerminalRelease({
          runtime,
          db,
          dispatchId: params.dispatch,
          resource: requested.resource
        })
      }
      if (requested.disposition === 'reconcile') {
        return reconcileUnknownWorkerTerminalRelease({
          runtime,
          db,
          dispatchId: params.dispatch,
          resource: requested.resource
        })
      }
      if (requested.disposition === 'retained') {
        return {
          dispatchId: params.dispatch,
          state: 'retained',
          reason: requested.reason,
          processAction: 'none',
          archive: archiveSummary(requested.resource)
        }
      }
      return completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: params.dispatch,
        resource: requested.resource
      })
    })
  }),
  defineMethod({
    name: 'orchestration.workerRetain',
    params: WorkerDispatchParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const retained = db.retainWorkerTerminalResource(params.dispatch)
      if (retained.disposition === 'already_released') {
        return {
          dispatchId: params.dispatch,
          state: 'already_released' as const,
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource)
        }
      }
      if (retained.disposition === 'no_owned_resource') {
        return {
          dispatchId: params.dispatch,
          state: 'retained' as const,
          reason: 'no_owned_resource' as const,
          processAction: 'none' as const,
          archive: null
        }
      }
      if (retained.disposition === 'release_committed') {
        const lifecycle = retained.resource.lifecycle_state
        return {
          dispatchId: params.dispatch,
          state:
            lifecycle === 'release_unknown'
              ? ('release_unknown' as const)
              : lifecycle === 'contained'
                ? ('contained' as const)
                : ('release_pending' as const),
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource),
          ...(retained.resource.release_error
            ? { lastError: retained.resource.release_error }
            : {}),
          recovery:
            lifecycle === 'contained'
              ? 'Lost custody is already contained; no process action was taken and capacity remains withheld.'
              : 'Terminal release was already committed and could not be changed to retained; inspect worker-show before taking further action.'
        }
      }
      return {
        dispatchId: params.dispatch,
        state: 'retained' as const,
        reason: 'user_requested' as const,
        processAction: 'none' as const,
        archive: archiveSummary(retained.resource)
      }
    }
  }),
  defineMethod({
    name: 'orchestration.workerList',
    params: WorkerListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const rows = db.listWorkerTerminalResources({ runId: params.run })
      const workers = rows
        .filter((row) => !params.terminalState || row.terminalState === params.terminalState)
        .map((row) => {
          const containment = row.resource
            ? db.getWorkerTerminalContainment(row.resource.id)
            : undefined
          return {
            dispatchId: row.dispatchId,
            taskId: row.taskId,
            runId: row.runId,
            workerState: row.workerState,
            dispatchStatus: row.dispatchStatus,
            agentTerminalHandle: row.agentTerminalHandle,
            terminalState: row.terminalState,
            resource: row.resource ? exposeWorkerTerminalResource(row.resource) : null,
            ...(containment ? { containment: exposeWorkerTerminalContainment(containment) } : {})
          }
        })
      const counts: Partial<Record<WorkerTerminalListState, number>> = {}
      for (const row of rows) {
        if (row.terminalState) {
          counts[row.terminalState] = (counts[row.terminalState] ?? 0) + 1
        }
      }
      return { workers, counts }
    }
  }),
  defineMethod({
    name: 'orchestration.workerTerminalUserInput',
    params: z.object({ paneKey: requiredString('Missing paneKey') }),
    // Real user keystrokes durably relinquish orchestration ownership on the owning runtime, so
    // restarts, SSH drops, remote viewing, and renderer remounts cannot erase the takeover.
    handler: (params, { runtime }) => ({
      changed: runtime.getOrchestrationDb().markWorkerTerminalUserOwned(params.paneKey)
    })
  })
]

function withWorkerReleaseFinality(
  handler: RpcHandler<z.infer<typeof WorkerDispatchParams>>
): RpcHandler<z.infer<typeof WorkerDispatchParams>> {
  return async (params, context: RpcContext) => {
    const receipt = (await handler(params, context)) as WorkerReleaseReceipt
    if (!['released', 'already_released', 'retained'].includes(receipt.state)) {
      context.deferMutationCompletion?.()
    }
    return receipt
  }
}
