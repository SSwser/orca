import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { OrchestrationDb } from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { DispatchContextRow, TaskRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  acquireWorkerGenerationEffect,
  operationInProgressReceipt
} from './orchestration-worker-generation-effect'
import {
  buildWorkerExecutionStartOperation,
  type WorkerGenerationOperationIdentities
} from './orchestration-worker-generation-identity'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import {
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'

export async function activateWorkerGeneration(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: TaskRow
  dispatch: DispatchContextRow
  params: WorkerStartInput
  operations: WorkerGenerationOperationIdentities
  runtimeEpoch: string
  claimantId: string
  resolvedWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
  launchReceipt: unknown
  launchPreferences?: AgentLaunchPreferences
  terminalRevealWarning?: string
  setFailedStage: (stage: string) => void
}): Promise<unknown> {
  const { runtime, db, runId, task, dispatch, params, operations, effects } = args
  const terminalHandle = operations.executionStart.terminalHandle
  const setupStage = {
    db,
    dispatchId: dispatch.id,
    worktreeId: args.resolvedWorktree.id,
    terminalHandle,
    setup: args.setupReceipt,
    effects
  }
  if (persistGatedSetupSpawnFailure(setupStage)) {
    args.setFailedStage('setup_start')
    throw new Error('Setup terminal failed to start before the gated agent launch.')
  }
  if (
    args.setupReceipt.startupPolicy === 'wait-for-setup' &&
    args.setupReceipt.state === 'running'
  ) {
    const setupTerminal = effects.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
    )
    if (!setupTerminal?.id) {
      args.setFailedStage('setup_wait')
      throw new Error('Setup terminal identity is unavailable for the gated agent launch.')
    }
    args.setFailedStage('setup_wait')
    const wait = await runtime.waitForTerminal(setupTerminal.id, {
      condition: 'exit',
      timeoutMs: params.timeoutMs ?? 60_000
    })
    persistWorkerSetupWaitOutcome({ ...setupStage, wait })
    if ((args.setupReceipt as WorkerSetupReceipt).state !== 'succeeded') {
      throw new Error(
        wait.status === 'exited'
          ? 'Setup failed before the gated agent launch.'
          : 'Setup did not finish before the gated agent launch timeout.'
      )
    }
  }

  const capability = db.reserveStartingWorkerCapability(dispatch.id)
  const targetFingerprint = (
    JSON.parse(db.getWorkerDispatch(dispatch.id)?.start_options ?? '{}') as {
      executionTargetFingerprint?: unknown
    }
  ).executionTargetFingerprint
  if (typeof targetFingerprint !== 'string' || targetFingerprint.length !== 64) {
    throw new Error('worker_execution_start_unsupported')
  }
  const prompt = buildDispatchPreamble({
    taskId: task.id,
    dispatchId: dispatch.id,
    taskSpec: task.spec,
    coordinatorHandle: params.from,
    workerHandle: terminalHandle,
    dispatchCapability: capability,
    devMode: params.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  })
  const operation = buildWorkerExecutionStartOperation({
    dispatchId: dispatch.id,
    executionSeedOperationId: operations.executionStart.operationId,
    terminalHandle,
    prompt,
    capability,
    targetFingerprint
  })
  const launchToken = runtime.deriveWorkerAgentLaunchToken(capability)
  const executionStart = {
    ...operation,
    targetFingerprint,
    terminalHandle,
    launchToken,
    writeFence: { ownerId: dispatch.id, generation: operation.operationId },
    semanticBaselineAt: Date.parse(dispatch.created_at),
    timeoutMs: params.timeoutMs ?? 60_000
  }
  const claim = await acquireWorkerGenerationEffect({
    db,
    dispatchId: dispatch.id,
    effectKind: 'execution_start',
    identity: operation,
    runtimeEpoch: args.runtimeEpoch,
    claimantId: args.claimantId,
    inspect: async () => {
      const inspection = await runtime.inspectAgentSessionExecutionStart(
        `id:${args.resolvedWorktree.id}`,
        executionStart
      )
      if (inspection.verdict === 'accepted') {
        return { verdict: 'accepted', receipt: inspection.receipt }
      }
      return inspection.verdict === 'started'
        ? { verdict: 'started' }
        : { verdict: inspection.verdict }
    }
  })
  if (claim.disposition === 'in_progress') {
    return operationInProgressReceipt({
      db,
      runId,
      taskId: task.id,
      dispatchId: dispatch.id,
      effectKind: 'execution_start',
      effects
    })
  }

  args.setFailedStage('execution_start')
  const result =
    claim.disposition === 'completed'
      ? null
      : await runtime.createAgentSession(
          {
            clientOperationId: `${executionStart.semanticBaselineAt}-${operation.payloadFingerprint.slice(0, 32)}`,
            worktree: `id:${args.resolvedWorktree.id}`,
            agent: 'codex',
            prompt,
            promptDelivery: 'auto-submit',
            presentation: 'background',
            placement: {
              tabId: operations.executionStart.tabId,
              leafId: operations.executionStart.leafId
            },
            ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
            executionStart
          },
          { clientKind: 'runtime' }
        )
  const receipt = claim.disposition === 'completed' ? claim.receipt : result?.executionStartReceipt
  if (!receipt || typeof receipt !== 'object') {
    throw Object.assign(new Error('worker_execution_start_unconfirmed'), {
      agentSessionOperationOutcome: 'unknown' as const
    })
  }
  const exact = receipt as {
    paneKey: string
    processIncarnation: string
    hostScope: unknown
    semanticObservedAt: number
  }
  if (!Number.isFinite(exact.semanticObservedAt)) {
    throw new Error('worker_execution_start_unconfirmed')
  }
  const authority = requireWorkerAuthority(runtime, terminalHandle, {
    requireNativeWindowsRestartCustody: process.platform === 'win32'
  })
  if (
    authority.paneKey !== exact.paneKey ||
    authority.processIncarnation !== exact.processIncarnation
  ) {
    throw new Error('worker_execution_start_conflict')
  }
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: terminalHandle,
    ...authority,
    hostScope: JSON.stringify(exact.hostScope),
    capability,
    worktreeId: args.resolvedWorktree.id,
    effects,
    setupState: args.setupReceipt.state,
    terminalOwnership: 'created',
    ...(claim.disposition !== 'completed'
      ? { generationOperation: { ...operation, claimantId: args.claimantId, receipt } }
      : {})
  })
  effects.push(
    {
      kind: 'terminal',
      role: 'agent',
      action:
        result?.disposition === 'replayed' || claim.disposition === 'completed'
          ? 'replayed'
          : 'created',
      id: terminalHandle,
      surface: result?.terminal.surface ?? 'background'
    },
    {
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: claim.disposition === 'completed' ? 'replayed' : 'accepted'
    }
  )
  const worker = db.markWorkerDispatchReady(dispatch.id, effects)
  monitorWorkerSetup({
    runtime,
    db,
    runId,
    dispatchId: dispatch.id,
    setupReceipt: args.setupReceipt,
    effects
  })
  return {
    runId,
    taskId: task.id,
    dispatchId: dispatch.id,
    state: worker.state,
    stage: worker.stage,
    setup: args.setupReceipt,
    launch: args.launchReceipt,
    timeoutMs: params.timeoutMs ?? 60_000,
    effects,
    residualResources: [],
    ...(args.terminalRevealWarning ? { warning: args.terminalRevealWarning } : {})
  }
}
