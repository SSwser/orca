import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import { prepareWorkerExecutionAdmission } from './orchestration-worker-execution-admission'
import { executeAcceptedLocalWorkerStart } from './orchestration-worker-start-executor'
import { prepareLocalWorkerExecution } from './orchestration-worker-start-preparation'

describe('orchestration Worker execution start', () => {
  const harness = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = harness
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let context: RpcContext

  function setup(): void {
    ;({ db, runtime, ctx: context } = harness.setup(true))
  }

  afterEach(() => harness.cleanup())

  async function call(params: Record<string, unknown>) {
    return harness.call('orchestration.workerStart', params, context)
  }

  function mockLocalCodexSession(): ReturnType<typeof vi.spyOn> {
    vi.spyOn(runtime, 'resolveWorkerAgentProcessAdmission').mockReturnValue({
      targetFingerprint: 'c'.repeat(64)
    })
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(
      async (selector) => ({ id: selector.replace(/^id:/, ''), repoId: 'repo' }) as never
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : 'tab_worker:leaf_worker'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_coord' ? 'daemon:coord:1' : 'daemon:worker:1'
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle) =>
        ({
          runtimeId: 'runtime-test',
          terminalHandle: handle,
          ptyId: handle === 'term_coord' ? 'pty-coord' : 'pty-worker',
          worktreeId: 'repo::worktree',
          paneKey: handle === 'term_coord' ? coordinatorPaneKey : 'tab_worker:leaf_worker',
          processIncarnation: handle === 'term_coord' ? 'daemon:coord:1' : 'daemon:worker:1',
          launchTokenHash: null,
          hostScope: {
            kind: 'local',
            hostId: 'local',
            restartCustody: {
              kind: 'windows_daemon_job',
              daemonPid: 4000,
              daemonStartedAtMs: 1_786_000_000_000,
              daemonLaunchNonce: 'worker-test-daemon'
            }
          }
        }) as never
    )
    return vi.spyOn(runtime, 'createAgentSession').mockImplementation(async (request) => {
      const start = request.executionStart!
      return {
        terminal: {
          handle: start.terminalHandle,
          worktreeId: request.worktree.replace(/^id:/, ''),
          title: 'Codex',
          surface: 'background'
        },
        disposition: 'created',
        executionStartReceipt: {
          ...start,
          launchTokenHash: 'test-launch-token-hash',
          paneKey: 'tab_worker:leaf_worker',
          processIncarnation: 'daemon:worker:1',
          hostScope: {
            kind: 'local',
            hostId: 'local',
            restartCustody: {
              kind: 'windows_daemon_job',
              daemonPid: 4000,
              daemonStartedAtMs: 1_786_000_000_000,
              daemonLaunchNonce: 'worker-test-daemon'
            }
          },
          providerSession: { key: 'session_id', id: 'codex-session' },
          turnStartedAt: Date.now(),
          semanticObservedAt: Date.now()
        }
      }
    })
  }

  it('atomically creates one Codex Session with the complete first turn', async () => {
    setup()
    const createSession = mockLocalCodexSession()
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const sendPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
    const task = db.createTask({ spec: 'complete the exact worker task' })

    await expect(
      call({ task: task.id, from: 'term_coord', worktree: 'current', agent: 'codex' })
    ).resolves.toMatchObject({ state: 'ready', stage: 'input_accepted' })

    expect(createSession).toHaveBeenCalledOnce()
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        promptDelivery: 'auto-submit',
        presentation: 'background',
        prompt: expect.stringContaining('complete the exact worker task'),
        executionStart: expect.objectContaining({
          operationId: expect.any(String),
          payloadFingerprint: expect.any(String),
          writeFence: expect.any(Object)
        })
      }),
      { clientKind: 'runtime' }
    )
    expect(createTerminal).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
    const dispatch = db.getDispatchContext(task.id)!
    expect(db.getWorkerTerminalResourceByOwner(dispatch.id)).toMatchObject({
      lifecycle_state: 'owned'
    })
  })

  it('rejects an unsupported structured launch before persisting a Dispatch', async () => {
    setup()
    const createSession = mockLocalCodexSession()
    vi.mocked(runtime.resolveWorkerAgentProcessAdmission).mockImplementation(() => {
      throw new Error('worker_execution_start_argv_too_large')
    })
    const run = db.getCurrentRunForPane(coordinatorPaneKey)!
    const task = db.createTask({ spec: 'x'.repeat(40_000), runId: run.id })

    await expect(
      call({ task: task.id, from: 'term_coord', worktree: 'current', agent: 'codex' })
    ).rejects.toThrow('worker_execution_start_argv_too_large')

    expect(db.getDispatchContext(task.id)).toBeUndefined()
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(createSession).not.toHaveBeenCalled()
  })

  it.each([
    [{ agent: 'claude' }, 'agent_unconfigured'],
    [{ agent: 'codex', terminal: 'term_existing' }, 'invalid_argument'],
    [{ agent: 'codex', on: 'remote-orca' }, 'execution_host_unavailable']
  ])(
    'rejects unsupported execution before Dispatch or Session effects',
    async (overrides, code) => {
      setup()
      mockLocalCodexSession()
      const task = db.createTask({ spec: 'must not start remotely' })

      await expect(
        call({ task: task.id, from: 'term_coord', worktree: 'current', ...overrides })
      ).rejects.toMatchObject({ code })
      expect(db.getDispatchContext(task.id)).toBeUndefined()
      expect(runtime.createAgentSession).not.toHaveBeenCalled()
    }
  )

  it('passes opaque Codex launch preferences through the native Session create', async () => {
    setup()
    const createSession = mockLocalCodexSession()
    const task = db.createTask({ spec: 'use the selected Codex model' })

    await expect(
      call({
        task: task.id,
        from: 'term_coord',
        worktree: 'current',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high'
      })
    ).resolves.toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
        effective: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
      }
    })
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ launchPreferences: { model: 'gpt-5.6-sol', effort: 'high' } }),
      { clientKind: 'runtime' }
    )
  })

  it.each(['repo::other', 'folder:workspace-1'])(
    'starts in an exact existing workspace without assuming Git: %s',
    async (workspaceId) => {
      setup()
      const createSession = mockLocalCodexSession()
      const task = db.createTask({ spec: 'work in the selected workspace' })

      await expect(
        call({ task: task.id, from: 'term_coord', worktree: `id:${workspaceId}`, agent: 'codex' })
      ).resolves.toMatchObject({ state: 'ready' })
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: `id:${workspaceId}` }),
        { clientKind: 'runtime' }
      )
    }
  )

  it('creates a new worktree without an initial agent Terminal, then starts one Session', async () => {
    setup()
    const createSession = mockLocalCodexSession()
    vi.mocked(runtime.showManagedWorktree).mockResolvedValue({
      id: 'repo::parent',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::child', repoId: 'repo' },
      startupTerminal: { spawned: false },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    } as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    } as never)
    const task = db.createTask({ spec: 'create a child generation' })

    await expect(
      call({
        task: task.id,
        from: 'term_coord',
        worktree: 'new-child',
        name: 'child-worker',
        agent: 'codex'
      })
    ).resolves.toMatchObject({ state: 'ready' })
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ suppressInitialTerminal: true, runHooks: false })
    )
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: 'id:repo::child' }),
      { clientKind: 'runtime' }
    )
  })

  it('does not activate capability or create a Worker resource without an exact receipt', async () => {
    setup()
    mockLocalCodexSession()
    vi.mocked(runtime.createAgentSession).mockRejectedValue(
      Object.assign(new Error('worker_execution_start_unverifiable'), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    )
    const task = db.createTask({ spec: 'ambiguous start' })

    const result = (await call({
      task: task.id,
      from: 'term_coord',
      worktree: 'current',
      agent: 'codex'
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('outcome_unknown')
    expect(db.getWorkerTerminalResourceByOwner(result.dispatchId)).toBeUndefined()
    const dispatch = db.getDispatchContextById(result.dispatchId)!
    expect(dispatch.assignee_handle).toBeNull()
  })

  it('resumes one started execution operation after runtime restart without Terminal input', async () => {
    setup()
    const createSession = mockLocalCodexSession()
    const sendTerminalAgentPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
    const runtimeId = vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('runtime-before')
    const run = db.getCurrentRunForPane(coordinatorPaneKey)!
    const task = db.createTask({ spec: 'restart between spawn and create reply', runId: run.id })
    const prepared = await prepareLocalWorkerExecution({
      runtime,
      params: {
        task: task.id,
        from: 'term_coord',
        worktree: 'current',
        agent: 'codex',
        timeoutMs: 60_000
      }
    })
    const admission = prepareWorkerExecutionAdmission({
      runtime,
      task,
      coordinatorHandle: 'term_coord',
      startOptions: prepared.startOptions
    })
    prepared.startOptions = admission.startOptions
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      dispatchId: admission.dispatchId,
      provisionalCapability: admission.provisionalCapability,
      launchTokenHash: admission.launchTokenHash,
      startOptions: prepared.startOptions,
      runtimeEpoch: 'runtime-before'
    })
    createSession.mockRejectedValueOnce(
      Object.assign(new Error('create reply lost'), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    )

    await expect(
      executeAcceptedLocalWorkerStart({ runtime, db, runId: run.id, task, started, prepared })
    ).resolves.toMatchObject({ state: 'outcome_unknown' })
    vi.spyOn(runtime, 'inspectAgentSessionExecutionStart').mockResolvedValue({
      verdict: 'started',
      terminalHandle: 'term_worker',
      processIncarnation: 'daemon:worker:1'
    })
    runtimeId.mockReturnValue('runtime-after')
    context = { ...context, resumedWorkerStartDispatchId: started.dispatch.id }

    await expect(
      call({ task: task.id, from: 'term_coord', worktree: 'current', agent: 'codex' })
    ).resolves.toMatchObject({ state: 'ready', stage: 'input_accepted' })
    expect(createSession).toHaveBeenCalledTimes(2)
    const [first, second] = createSession.mock.calls.map(([request]) => request)
    expect(second.executionStart).toEqual(first.executionStart)
    expect(second.prompt).toBe(first.prompt)
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('attaches exact Dispatch authority when restart inspection accepts the execution', async () => {
    setup()
    const createSession = mockLocalCodexSession()
    const runtimeId = vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('runtime-before')
    const run = db.getCurrentRunForPane(coordinatorPaneKey)!
    const task = db.createTask({ spec: 'recover accepted execution authority', runId: run.id })
    const prepared = await prepareLocalWorkerExecution({
      runtime,
      params: {
        task: task.id,
        from: 'term_coord',
        worktree: 'current',
        agent: 'codex',
        timeoutMs: 60_000
      }
    })
    const admission = prepareWorkerExecutionAdmission({
      runtime,
      task,
      coordinatorHandle: 'term_coord',
      startOptions: prepared.startOptions
    })
    prepared.startOptions = admission.startOptions
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      dispatchId: admission.dispatchId,
      provisionalCapability: admission.provisionalCapability,
      launchTokenHash: admission.launchTokenHash,
      startOptions: prepared.startOptions,
      runtimeEpoch: 'runtime-before'
    })
    createSession.mockRejectedValueOnce(
      Object.assign(new Error('create reply lost'), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    )

    await expect(
      executeAcceptedLocalWorkerStart({ runtime, db, runId: run.id, task, started, prepared })
    ).resolves.toMatchObject({ state: 'outcome_unknown' })
    const executionStart = createSession.mock.calls[0]![0].executionStart!
    vi.spyOn(runtime, 'inspectAgentSessionExecutionStart').mockResolvedValue({
      verdict: 'accepted',
      receipt: {
        ...executionStart,
        launchTokenHash: 'test-launch-token-hash',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'daemon:worker:1',
        hostScope: {
          kind: 'local',
          hostId: 'local',
          restartCustody: {
            kind: 'windows_daemon_job',
            daemonPid: 4000,
            daemonStartedAtMs: 1_786_000_000_000,
            daemonLaunchNonce: 'worker-test-daemon'
          }
        },
        providerSession: { key: 'session_id', id: 'codex-session' },
        turnStartedAt: Date.now(),
        semanticObservedAt: Date.now()
      }
    })
    runtimeId.mockReturnValue('runtime-after')
    context = { ...context, resumedWorkerStartDispatchId: started.dispatch.id }

    await expect(
      call({ task: task.id, from: 'term_coord', worktree: 'current', agent: 'codex' })
    ).resolves.toMatchObject({ state: 'ready', stage: 'input_accepted' })
    expect(createSession).toHaveBeenCalledOnce()
    expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
      assignee_handle: executionStart.terminalHandle,
      assignee_pane_key: 'tab_worker:leaf_worker',
      process_incarnation: 'daemon:worker:1'
    })
  })
})
