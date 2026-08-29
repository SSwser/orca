import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import { ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  inspectWorkerTerminal,
  resolvePinnedFederatedServer
} from './orchestration-worker-observation'
import { captureWorkerTerminalArchiveOnce } from './orchestration-worker-archive-capture'
import { orchestrationTimestampToMs } from './orchestration-worker-output'
import { archiveSummary } from './orchestration-worker-release-completion'

const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

export const ORCHESTRATION_WORKER_STOP_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStop',
    params: WorkerDispatchParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        if (!orchestrationMutation) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker-stop requires a durable retry request.'
          )
        }
        const server = resolvePinnedFederatedServer(runtime, federated)
        const begun = db.beginWorkerStop(params.dispatch, runtime.getRuntimeId())
        if (begun.disposition === 'already_settled') {
          return settledReceipt(params.dispatch, begun.worker.state)
        }
        try {
          const status = (await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'status.get',
            undefined,
            30_000
          )) as RuntimeStatus
          if (
            !status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY)
          ) {
            return unknownReceipt(
              params.dispatch,
              db.markWorkerStopUnknown(
                params.dispatch,
                `Connected server ${server.name} cannot prove the worker stop outcome.`
              ),
              'none'
            )
          }
          const remote = (await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'orchestration.federationStop',
            { dispatchId: params.dispatch },
            30_000,
            { orchestrationRequestId: orchestrationMutation.requestId }
          )) as RemoteStopReceipt
          if (remote.state === 'stopped') {
            const worker = db.reconcileFederatedWorkerStop(params.dispatch)
            return {
              dispatchId: params.dispatch,
              state: worker.state,
              alreadySettled: remote.alreadySettled,
              processAction: remote.processAction,
              close: remote.close
            }
          }
          if (remote.state === 'succeeded' || remote.state === 'failed') {
            db.resumeFederatedWorkerForTerminalRelay(params.dispatch)
            await runtime
              .syncOrchestrationFederatedDispatchAfterCurrent(params.dispatch)
              .catch(() => undefined)
            return {
              dispatchId: params.dispatch,
              state: db.getWorkerDispatch(params.dispatch)?.state ?? remote.state,
              alreadySettled: true,
              processAction: 'none'
            }
          }
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              remote.lastError ?? `The worker server returned ${remote.state}.`
            ),
            remote.processAction
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(params.dispatch, reason),
            'unknown'
          )
        }
      }

      const begun = db.beginWorkerStop(params.dispatch, runtime.getRuntimeId())
      if (begun.disposition === 'already_settled') {
        return settledReceipt(params.dispatch, begun.worker.state)
      }
      if (begun.disposition === 'context_only') {
        if (!begun.alreadySettled) {
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        }
        return {
          dispatchId: params.dispatch,
          state: begun.state,
          alreadySettled: begun.alreadySettled,
          processAction: 'none' as const,
          warning: contextOnlyStopWarning(begun)
        }
      }
      const handle = begun.worker.agent_terminal_handle
      if (!handle) {
        return unknownReceipt(
          params.dispatch,
          db.markWorkerStopUnknown(params.dispatch, 'The Dispatch has no recorded agent terminal.'),
          'unknown'
        )
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      // Why `unverifiable` still proceeds: losing contact is a reason to report
      // the outcome honestly, never a reason to stop trying to stop the worker.
      if (
        !observation.exact ||
        (observation.status !== 'live' && observation.status !== 'unverifiable')
      ) {
        return unknownReceipt(
          params.dispatch,
          db.markWorkerStopUnknown(
            params.dispatch,
            `The recorded worker process is ${observation.status}; no terminal was closed.`
          ),
          'none'
        )
      }
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      if (!resource || resource.lifecycle_state !== 'owned') {
        const lifecycle = resource?.lifecycle_state ?? 'unproven'
        return unknownReceipt(
          params.dispatch,
          db.markWorkerStopUnknown(
            params.dispatch,
            `The worker terminal lifecycle is ${lifecycle}; no terminal was closed.`
          ),
          'none'
        )
      }
      if (!resource.process_incarnation) {
        return unknownReceipt(
          params.dispatch,
          db.markWorkerStopUnknown(
            params.dispatch,
            'The worker terminal has no exact process incarnation; no terminal was closed.'
          ),
          'none'
        )
      }
      let closeAttempted = false
      try {
        const archive = await captureWorkerTerminalArchiveOnce({
          runtime,
          db,
          dispatchId: params.dispatch,
          terminalHandle: handle,
          attachedAtMs: orchestrationTimestampToMs(begun.worker.created_at)
        })
        const archivedResource = db.commitWorkerTerminalArchiveForStop({
          dispatchId: params.dispatch,
          resourceId: resource.id,
          processIncarnation: resource.process_incarnation,
          ...(archive.kind && archive.content
            ? { kind: archive.kind, content: archive.content }
            : {}),
          archiveSource: archive.source,
          archiveStatus: archive.status
        })
        const current = await inspectWorkerTerminal(runtime, db, params.dispatch)
        if (!current.exact || (current.status !== 'live' && current.status !== 'unverifiable')) {
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              `The recorded worker process changed to ${current.status} after archive capture; no terminal was closed.`
            ),
            'none',
            archiveSummary(archivedResource)
          )
        }
        closeAttempted = true
        const close = await runtime.closeTerminal(handle)
        if (!close.ptyKilled) {
          const exitSettled = db.getWorkerDispatch(params.dispatch)
          if (exitSettled?.state === 'stopped') {
            runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
            return {
              dispatchId: params.dispatch,
              state: exitSettled.state,
              alreadySettled: false,
              processAction: 'closed_agent_terminal',
              close,
              archive: archiveSummary(archivedResource)
            }
          }
          // The tab is retired, but the agent process was never confirmed stopped —
          // settling here is the false success this receipt exists to prevent.
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(params.dispatch, describeUnconfirmedAgentStop(close)),
            'closed_agent_terminal',
            archiveSummary(archivedResource)
          )
        }
        const worker = db.settleWorkerStop(params.dispatch)
        runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        return {
          dispatchId: params.dispatch,
          state: worker.state,
          alreadySettled: false,
          processAction: 'closed_agent_terminal',
          close,
          archive: archiveSummary(archivedResource)
        }
      } catch (error) {
        const exitSettled = db.getWorkerDispatch(params.dispatch)
        if (exitSettled?.state === 'stopped') {
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
          return {
            dispatchId: params.dispatch,
            state: exitSettled.state,
            alreadySettled: false,
            processAction: closeAttempted ? 'closed_agent_terminal' : 'none',
            archive: archiveSummary(db.getWorkerTerminalResourceByOwner(params.dispatch) ?? null)
          }
        }
        const reason = error instanceof Error ? error.message : String(error)
        return unknownReceipt(
          params.dispatch,
          db.markWorkerStopUnknown(params.dispatch, reason),
          'unknown'
        )
      }
    }
  })
]

type RemoteStopReceipt = {
  state: string
  alreadySettled: boolean
  processAction: string
  close?: unknown
  lastError?: string | null
}

function settledReceipt(dispatchId: string, state: string) {
  return { dispatchId, state, alreadySettled: true, processAction: 'none' }
}

function contextOnlyStopWarning(result: {
  state: string
  alreadySettled: boolean
  releasedCurrentTask: boolean
}): string {
  if (result.alreadySettled) {
    return `Dispatch was already ${result.state}; no terminal process changed.`
  }
  return result.releasedCurrentTask
    ? 'The assignment was stopped without closing its unsupervised terminal process.'
    : 'The superseded assignment was stopped without changing the current Task or terminal process.'
}

function unknownReceipt(
  dispatchId: string,
  worker: { state: string; last_error: string | null },
  processAction: string,
  archive: { source: string | null; status: string | null } | null = null
) {
  return {
    dispatchId,
    state: worker.state,
    alreadySettled: false,
    processAction,
    lastError: worker.last_error,
    archive
  }
}
