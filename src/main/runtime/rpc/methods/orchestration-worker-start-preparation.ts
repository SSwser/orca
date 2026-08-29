import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'

export async function prepareLocalWorkerExecution(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
}): Promise<{
  params: WorkerStartInput
  requestedWorktree: string
  creationWorktree?: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  resolvedWorktree?: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  agent?: TuiAgent
  launch: ReturnType<typeof prepareLocalWorkerStart>['launch']
  startOptions: Record<string, unknown>
}> {
  const { runtime, params } = args
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })
  if (agent !== 'codex' || params.terminal) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'Supervised Worker execution start currently supports only a new local Codex Session.'
    )
  }
  const coordinatorTerminal = await runtime.showTerminal(params.from)
  const coordinatorAuthority = runtime.getOrchestrationDispatchAuthority(params.from)
  if (!coordinatorAuthority || coordinatorAuthority.hostScope.kind !== 'local') {
    throw new OrchestrationError(
      'execution_host_unavailable',
      'Supervised Worker execution start requires local execution-host authority.'
    )
  }
  const creationWorktree = createsWorktree
    ? await runtime.showManagedWorktree(`id:${coordinatorTerminal.worktreeId}`)
    : undefined
  if (creationWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo ?? creationWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  const resolvedWorktree = creationWorktree
    ? undefined
    : requestedWorktree === 'current'
      ? await runtime.showManagedTerminalWorkspace(`id:${coordinatorTerminal.worktreeId}`)
      : await runtime.showManagedTerminalWorkspace(requestedWorktree)
  const executionRuntime = runtime.resolveProjectRuntimeForWorktree(
    resolvedWorktree?.id ?? creationWorktree?.id
  )
  if (
    executionRuntime &&
    (executionRuntime.status !== 'resolved' || executionRuntime.runtime.kind === 'wsl')
  ) {
    throw new OrchestrationError(
      'execution_host_unavailable',
      'Supervised Worker execution start is unavailable for this workspace execution host.'
    )
  }
  return {
    params,
    requestedWorktree,
    creationWorktree,
    resolvedWorktree,
    agent,
    launch,
    startOptions: {
      worktree: requestedWorktree,
      resolvedWorktreeId: resolvedWorktree?.id ?? null,
      name: params.name ?? null,
      repo: params.repo ?? creationWorktree?.repoId ?? null,
      baseBranch: params.baseBranch ?? null,
      terminal: params.terminal ?? null,
      agent: agent ?? null,
      launch: launch.receipt,
      timeoutMs: params.timeoutMs ?? 60_000,
      setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
      setupSource: createsWorktree
        ? params.setup
          ? 'explicit_request'
          : 'orchestration_default'
        : 'existing_worktree'
    }
  }
}

export type PreparedLocalWorkerStart = Awaited<ReturnType<typeof prepareLocalWorkerExecution>>
