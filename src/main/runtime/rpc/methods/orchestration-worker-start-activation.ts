import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { DispatchContextRow, TaskRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  createAgentPromptSubmissionUnconfirmedError,
  isAgentPromptSubmissionUnconfirmedError
} from '../../agent-prompt-submission-verification'
import {
  acquireWorkerGenerationEffect,
  operationInProgressReceipt
} from './orchestration-worker-generation-effect'
import {
  buildWorkerGenerationPromptOperation,
  type WorkerGenerationOperationIdentities
} from './orchestration-worker-generation-identity'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
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
  terminalHandle: string
  terminalOperationNeedsCompletion: boolean
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
  launchReceipt: unknown
  terminalRevealWarning?: string
  setFailedStage: (stage: string) => void
}): Promise<unknown> {
  const {
    runtime,
    db,
    runId,
    task,
    dispatch,
    params,
    operations,
    runtimeEpoch,
    claimantId,
    resolvedWorktree,
    terminalHandle,
    terminalOperationNeedsCompletion,
    setupReceipt,
    effects
  } = args
  const setupStage = {
    db,
    dispatchId: dispatch.id,
    worktreeId: resolvedWorktree.id,
    terminalHandle,
    setup: setupReceipt,
    effects
  }
  if (persistGatedSetupSpawnFailure(setupStage)) {
    args.setFailedStage('setup_start')
    throw new Error('Setup terminal failed to start before the gated agent launch.')
  }
  persistWorkerReadinessStage(setupStage)
  args.setFailedStage('agent_readiness')
  const wait = await runtime.waitForTerminal(terminalHandle, {
    condition: 'tui-idle',
    timeoutMs: params.timeoutMs ?? 60_000,
    requireAgentInputReady: true
  })
  persistWorkerSetupWaitOutcome({ ...setupStage, wait })
  if (!wait.satisfied) {
    if (setupReceipt.state === 'failed') {
      args.setFailedStage('setup_wait')
    }
    throw new Error(
      wait.blockedReason
        ? `Agent startup blocked: ${wait.blockedReason}`
        : `Agent did not become ready (${wait.status}).`
    )
  }
  const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle, {
    requireNativeWindowsRestartCustody: process.platform === 'win32' && !params.terminal
  })
  if (terminalOperationNeedsCompletion) {
    db.completeWorkerGenerationOperation({
      dispatchId: dispatch.id,
      effectKind: 'terminal',
      ...operations.terminal,
      claimantId,
      receipt: { terminalHandle, worktreeId: resolvedWorktree.id, ...terminalAuthority }
    })
  }
  const authorityOperation = await acquireWorkerGenerationEffect({
    db,
    dispatchId: dispatch.id,
    effectKind: 'authority',
    identity: operations.authority,
    runtimeEpoch,
    claimantId,
    inspect: async () => {
      const currentDispatch = db.getDispatchContextById(dispatch.id)
      if (!currentDispatch?.assignee_handle) {
        return { verdict: 'not_started' }
      }
      if (
        currentDispatch.assignee_handle !== terminalHandle ||
        currentDispatch.assignee_pane_key !== terminalAuthority.paneKey ||
        currentDispatch.process_incarnation !== terminalAuthority.processIncarnation
      ) {
        return { verdict: 'conflict' }
      }
      return { verdict: 'unverifiable' }
    }
  })
  if (authorityOperation.disposition === 'in_progress') {
    return operationInProgressReceipt({
      db,
      runId,
      taskId: task.id,
      dispatchId: dispatch.id,
      effectKind: 'authority',
      effects
    })
  }
  const capability =
    authorityOperation.disposition === 'completed'
      ? (authorityOperation.receipt as { capability: string }).capability
      : db.prepareStartingWorkerAuthority({
          dispatchId: dispatch.id,
          handle: terminalHandle,
          ...terminalAuthority,
          worktreeId: resolvedWorktree.id,
          effects,
          setupState: setupReceipt.state,
          terminalOwnership: params.terminal ? 'external' : 'created',
          generationOperation: { ...operations.authority, claimantId }
        })
  args.setFailedStage('dispatch_input')
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
  const promptOperation = buildWorkerGenerationPromptOperation({
    dispatchId: dispatch.id,
    terminalOperationId: operations.terminal.operationId,
    terminalHandle,
    prompt
  })
  const promptOperationClaim = await acquireWorkerGenerationEffect({
    db,
    dispatchId: dispatch.id,
    effectKind: 'prompt',
    identity: promptOperation,
    runtimeEpoch,
    claimantId,
    inspect: async () =>
      await runtime.inspectTerminalWorkerPromptOperation(terminalHandle, promptOperation)
  })
  if (promptOperationClaim.disposition === 'in_progress') {
    return operationInProgressReceipt({
      db,
      runId,
      taskId: task.id,
      dispatchId: dispatch.id,
      effectKind: 'prompt',
      effects
    })
  }
  if (db.getWorkerDispatch(dispatch.id)?.state === 'start_unknown') {
    db.resumeWorkerStartUnknown(dispatch.id)
  }
  if (promptOperationClaim.disposition === 'execute') {
    let acceptance: unknown
    try {
      acceptance = await runtime.sendTerminalAgentPrompt(terminalHandle, prompt, {
        workerPromptOperation: promptOperation
      })
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'operation_unknown') {
        throw error
      }
      let inspection
      try {
        inspection = await runtime.inspectTerminalWorkerPromptOperation(
          terminalHandle,
          promptOperation
        )
      } catch (inspectionError) {
        if (isAgentPromptSubmissionUnconfirmedError(inspectionError)) {
          db.markWorkerGenerationOperationUnverifiable({
            dispatchId: dispatch.id,
            effectKind: 'prompt',
            ...promptOperation,
            claimantId
          })
        }
        throw inspectionError
      }
      if (inspection.verdict === 'conflict') {
        throw new OrchestrationError(
          'request_mismatch',
          'Worker generation prompt owner reported an identity conflict.'
        )
      }
      if (inspection.verdict !== 'completed') {
        throw error
      }
      acceptance = inspection.receipt
    }
    if (!hasSemanticPromptProof(acceptance)) {
      throw createAgentPromptSubmissionUnconfirmedError()
    }
    db.completeWorkerGenerationOperation({
      dispatchId: dispatch.id,
      effectKind: 'prompt',
      ...promptOperation,
      claimantId,
      receipt: { terminalHandle, ...terminalAuthority, acceptance }
    })
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'accepted'
    })
  } else {
    if (promptOperationClaim.disposition !== 'completed') {
      throw createAgentPromptSubmissionUnconfirmedError()
    }
    if (!hasSemanticPromptProof(promptOperationClaim.receipt)) {
      throw createAgentPromptSubmissionUnconfirmedError()
    }
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'replayed'
    })
  }
  const worker = db.markWorkerDispatchReady(dispatch.id, effects)
  monitorWorkerSetup({
    runtime,
    db,
    runId,
    dispatchId: dispatch.id,
    setupReceipt,
    effects
  })
  return {
    runId,
    taskId: task.id,
    dispatchId: dispatch.id,
    state: worker.state,
    stage: worker.stage,
    setup: setupReceipt,
    launch: args.launchReceipt,
    timeoutMs: params.timeoutMs ?? 60_000,
    effects,
    residualResources: [],
    ...(args.terminalRevealWarning ? { warning: args.terminalRevealWarning } : {})
  }
}

function hasSemanticPromptProof(receipt: unknown): boolean {
  if (!receipt || typeof receipt !== 'object') {
    return false
  }
  const candidate = receipt as {
    semanticObservedAt?: unknown
    acceptance?: { semanticObservedAt?: unknown }
  }
  return (
    typeof candidate.semanticObservedAt === 'number' ||
    typeof candidate.acceptance?.semanticObservedAt === 'number'
  )
}
