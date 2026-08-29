import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerGenerationOperationIdentity } from './orchestration-worker-generation-identity'
import type { WorkerEffect, WorkerSetupReceipt } from './orchestration-worker-start-effects'

export {
  EXISTING_WORKTREE_SETUP_RECEIPT,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-start-effects'

export function isUnknownWorkerStartOutcome(error: unknown, stage: string): boolean {
  if (
    error &&
    typeof error === 'object' &&
    (error as { agentSessionOperationOutcome?: unknown }).agentSessionOperationOutcome === 'unknown'
  ) {
    return true
  }
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
  if (
    code === 'operation_unknown' ||
    code === 'worker_execution_start_unconfirmed' ||
    code === 'worker_execution_start_unverifiable'
  ) {
    return true
  }
  if (stage !== 'worktree_create') {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return /connection|disconnect|timed?\s*out|runtime changed|outcome unknown/i.test(message)
}

export function requireWorkerAuthority(
  runtime: OrcaRuntimeService,
  terminalHandle: string,
  options: { requireNativeWindowsRestartCustody?: boolean } = {}
) {
  const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
  if (
    options.requireNativeWindowsRestartCustody &&
    (!authority || (authority.hostScope.kind === 'local' && !authority.hostScope.restartCustody))
  ) {
    throw new Error('terminal_restart_custody_unavailable')
  }
  const paneKey = authority?.paneKey ?? runtime.getTerminalPaneKey(terminalHandle)
  const processIncarnation =
    authority?.processIncarnation ?? runtime.getTerminalProcessIncarnation(terminalHandle)
  if (!paneKey || !processIncarnation) {
    throw new Error('stable_pane_required')
  }
  return {
    paneKey,
    processIncarnation,
    ...(authority?.launchTokenHash ? { launchTokenHash: authority.launchTokenHash } : {}),
    ...(authority?.hostScope ? { hostScope: JSON.stringify(authority.hostScope) } : {})
  }
}

export function applyWaitForSetupOutcome(
  receipt: WorkerSetupReceipt,
  effects: WorkerEffect[],
  wait: { satisfied: boolean; status: string; exitCode?: number | null }
): void {
  if (receipt.startupPolicy !== 'wait-for-setup' || receipt.state !== 'running') {
    return
  }
  if (wait.satisfied && wait.exitCode === 0) {
    receipt.state = 'succeeded'
  } else if (wait.status === 'exited') {
    receipt.state = 'failed'
  } else {
    return
  }
  const setupEffect = effects.find((effect) => effect.kind === 'setup')
  if (setupEffect) {
    setupEffect.state = receipt.state
  }
}

export async function createWorkerWorktree(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  requestedWorktree: string
  coordinatorWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  params: {
    repo?: string
    name?: string
    baseBranch?: string
    displayName?: string
    comment?: string
    setup?: 'run' | 'skip' | 'inherit'
    from: string
  }
  operations?: {
    worktree: WorkerGenerationOperationIdentity & { branchName: string }
  }
  effects: WorkerEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  setupReceipt: WorkerSetupReceipt
}> {
  const { runtime, db, dispatchId, requestedWorktree, coordinatorWorktree, params, effects } = args
  const setupDecision = params.setup ?? 'run'
  db.recordWorkerStage({ dispatchId, stage: 'worktree_creating', effects })
  const created = await runtime.createManagedWorktree({
    repoSelector: params.repo ?? coordinatorWorktree.repoId,
    name: params.name as string,
    baseBranch: params.baseBranch,
    ...(args.operations ? { branchNameOverride: args.operations.worktree.branchName } : {}),
    displayName: params.displayName,
    comment: params.comment,
    // setupDecision runs setup without the legacy runHooks activation side effect.
    runHooks: false,
    setupDecision,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    suppressInitialTerminal: true,
    ...(args.operations
      ? {
          workerGenerationOperation: {
            operationId: args.operations.worktree.operationId,
            payloadFingerprint: args.operations.worktree.payloadFingerprint
          }
        }
      : {}),
    activate: false,
    lineage: {
      parentWorktree: requestedWorktree === 'new-child' ? coordinatorWorktree.id : undefined,
      noParent: requestedWorktree === 'new-top-level',
      callerTerminalHandle: params.from
    }
  })
  effects.push({
    kind: 'worktree',
    action: requestedWorktree === 'new-child' ? 'created_child' : 'created_top_level',
    id: created.worktree.id
  })
  db.recordWorkerStage({
    dispatchId,
    stage: 'worktree_created',
    worktreeId: created.worktree.id,
    effects,
    residualResources: effects
  })
  const setupReceipt = {
    requested: setupDecision,
    effective: setupDecision,
    source: params.setup ? 'explicit_request' : 'orchestration_default',
    hookFound: created.setupReceipt?.hookFound ?? false,
    startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
    state: created.setupReceipt?.state ?? 'not_configured'
  }
  const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
    includeVisualLayouts: false
  })
  const setupTerminalHandle = created.setupReceipt?.terminalHandle
  for (const terminal of listed.terminals) {
    effects.push({
      kind: 'terminal',
      role: terminal.handle === setupTerminalHandle ? 'setup' : 'configured_tab',
      action: 'created',
      id: terminal.handle,
      tabId: terminal.tabId,
      leafId: terminal.leafId
    })
  }
  const setupTerminal = effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup'
  )
  effects.push({
    kind: 'setup',
    action: setupDecision,
    requested: setupReceipt.requested,
    effective: setupReceipt.effective,
    source: setupReceipt.source,
    hookFound: setupReceipt.hookFound,
    startupPolicy: setupReceipt.startupPolicy,
    state: setupReceipt.state,
    terminalId: setupTerminalHandle ?? setupTerminal?.id
  })
  return {
    worktree: created.worktree as Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
    setupReceipt
  }
}

export function monitorWorkerSetup(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): void {
  const setupTerminal = args.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
  )
  if (
    !setupTerminal?.id ||
    args.setupReceipt.startupPolicy !== 'start-immediately' ||
    args.setupReceipt.state !== 'running'
  ) {
    return
  }
  // Why: setup is intentionally non-gating, but command completion remains durable evidence.
  void args.runtime
    .waitForSetupTerminalCompletion(setupTerminal.id)
    .then((completion) => {
      const setupState = completion.exitCode === 0 ? 'succeeded' : 'failed'
      const evidence = args.db.updateWorkerSetupEvidence({
        dispatchId: args.dispatchId,
        setupState,
        effects: args.effects.map((effect) =>
          effect.kind === 'setup' ? { ...effect, state: setupState } : effect
        )
      })
      if (!evidence.changed) {
        return
      }
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: `run:${args.runId}`,
        subject: `Setup ${setupState} for worker ${args.dispatchId}`,
        type: 'status',
        priority: setupState === 'failed' ? 'high' : 'normal',
        payload: JSON.stringify({
          dispatchId: args.dispatchId,
          setupState,
          terminalHandle: setupTerminal.id
        })
      })
      args.runtime.notifyMessageArrived(message.to_handle, message.type)
    })
    .catch(() => undefined)
}
