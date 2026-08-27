import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { ORCHESTRATION_WORKER_CONTAINMENT_RECOVERY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { formatWorkerRelease, type WorkerReleaseReceipt } from './worker-output'

const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'contained',
  'released'
] as const

export const ORCHESTRATION_WORKER_TERMINAL_HANDLERS: Record<string, CommandHandler> = {
  'orchestration worker-stop': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<{
      dispatchId: string
      state: string
      processAction: string
      lastError?: string
      warning?: string
    }>(client, flags, 'orchestration.workerStop', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    if (result.result.state === 'stop_unknown') {
      process.exitCode = 1
    }
    printResult(
      result,
      json,
      (value) =>
        `Worker ${value.dispatchId} [${value.state}] process=${value.processAction}${value.lastError ? `\n${value.lastError}` : ''}${value.warning ? `\nWarning: ${value.warning}` : ''}`
    )
  },

  'orchestration worker-abandon': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<{
      dispatchId: string
      state: string
      warning: string
    }>(client, flags, 'orchestration.workerAbandon', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    printResult(
      result,
      json,
      (value) => `Worker ${value.dispatchId} [${value.state}]\nWarning: ${value.warning}`
    )
  },

  'orchestration worker-release': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<WorkerReleaseReceipt>(
      client,
      flags,
      'orchestration.workerRelease',
      { dispatch: getRequiredStringFlag(flags, 'dispatch') }
    )
    // Why: only an unprovable close is a failure; retained/pending/already-released are settled answers.
    if (result.result.state === 'release_unknown') {
      process.exitCode = 1
    }
    printResult(result, json, formatWorkerRelease)
  },

  'orchestration worker-retain': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<WorkerReleaseReceipt>(
      client,
      flags,
      'orchestration.workerRetain',
      { dispatch: getRequiredStringFlag(flags, 'dispatch') }
    )
    if (result.result.state === 'release_unknown') {
      process.exitCode = 1
    }
    printResult(result, json, formatWorkerRelease)
  },

  'orchestration worker-recover': async ({ flags, client, cwd, json }) => {
    const status = await client.call<RuntimeStatus>('status.get')
    if (
      !status.result.capabilities?.includes(
        ORCHESTRATION_WORKER_CONTAINMENT_RECOVERY_RUNTIME_CAPABILITY
      )
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The connected Orca runtime does not support contained worker recovery.'
      )
    }
    if (!flags.has('authorize-lost-custody')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--authorize-lost-custody is required and acknowledges possible duplicate external effects.'
      )
    }
    const resolutionFlag = getRequiredStringFlag(flags, 'resolution')
    const resolution =
      resolutionFlag === 'accept-archived-result'
        ? ('accept_archived_result' as const)
        : resolutionFlag === 'retry-with-successor'
          ? ('retry_with_successor' as const)
          : null
    if (!resolution) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--resolution must be accept-archived-result or retry-with-successor.'
      )
    }
    const successor =
      resolution === 'retry_with_successor'
        ? {
            revision: getRequiredStringFlag(flags, 'revision'),
            worktree: getRequiredStringFlag(flags, 'worktree'),
            name: getRequiredStringFlag(flags, 'name'),
            repo: getOptionalStringFlag(flags, 'repo'),
            displayName: getOptionalStringFlag(flags, 'display-name'),
            comment: getOptionalStringFlag(flags, 'comment'),
            setup: getOptionalStringFlag(flags, 'setup'),
            agent: getRequiredStringFlag(flags, 'agent'),
            model: getOptionalStringFlag(flags, 'model'),
            effort: getOptionalStringFlag(flags, 'effort'),
            timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
          }
        : {}
    const result = await callOrchestrationMutation<{
      dispatchId: string
      taskId: string
      state: string
      stage: string
      failedStage?: string
      lastError?: string
      containment: { recoveryId: string; capacity: string; deliveryResolution: string }
    }>(client, flags, 'orchestration.workerRecover', {
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      resource: getRequiredStringFlag(flags, 'resource'),
      delivery: getRequiredStringFlag(flags, 'delivery'),
      resolution,
      ...successor,
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
      authorization:
        resolution === 'accept_archived_result'
          ? 'accept_authoritative_archived_result_with_lost_custody'
          : 'acknowledge_possible_duplicate_external_effects',
      devMode: isDevCliInvocation()
    })
    if (!['ready', 'contained'].includes(result.result.state)) {
      process.exitCode = 1
    }
    printResult(result, json, (value) => {
      const base = `Recovered ${value.taskId} -> ${value.dispatchId} [${value.state}]`
      return value.lastError
        ? `${base}\n${value.failedStage ?? value.stage}: ${value.lastError}`
        : `${base}\nContainment ${value.containment.recoveryId}: Delivery ${value.containment.deliveryResolution}, capacity ${value.containment.capacity}`
    })
  },

  'orchestration worker-list': async ({ flags, client, json }) => {
    const terminalState = getOptionalStringFlag(flags, 'terminal-state')
    if (
      terminalState &&
      !WORKER_TERMINAL_LIST_STATES.includes(
        terminalState as (typeof WORKER_TERMINAL_LIST_STATES)[number]
      )
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid --terminal-state '${terminalState}', expected one of: ${WORKER_TERMINAL_LIST_STATES.join(', ')}`
      )
    }
    const result = await client.call<{
      workers: {
        dispatchId: string
        taskId: string
        runId: string
        workerState: string
        dispatchStatus: string
        agentTerminalHandle: string | null
        terminalState: string | null
        resource: unknown
      }[]
      counts: Record<string, number>
    }>('orchestration.workerList', {
      run: getOptionalStringFlag(flags, 'run'),
      terminalState
    })
    printResult(result, json, (value) => {
      if (value.workers.length === 0) {
        return 'No workers found.'
      }
      const rows = value.workers
        .map(
          (worker) =>
            `${worker.dispatchId} task=${worker.taskId} [${worker.workerState}] terminal=${worker.terminalState ?? 'none'}`
        )
        .join('\n')
      const counts = Object.entries(value.counts)
        .map(([state, count]) => `${state}=${count}`)
        .join(' ')
      return counts ? `${rows}\nTerminals: ${counts}` : rows
    })
  }
}
