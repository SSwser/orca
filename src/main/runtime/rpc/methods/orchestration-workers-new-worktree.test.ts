import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration new-worktree workers', () => {
  type CreateWorktreeResult = Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let workerHandle: string
  const paths: string[] = []

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    workerHandle = 'term_worker'
    runId = db.createRun({
      objective: 'Test new-worktree workers',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === workerHandle
          ? 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === workerHandle ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_coord'
        ? ({
            terminalHandle: handle,
            paneKey: coordinatorPaneKey,
            processIncarnation: 'runtime_test:term_coord:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : handle === workerHandle
          ? ({
              terminalHandle: handle,
              paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              processIncarnation: 'runtime_test:term_worker:1',
              hostScope: {
                kind: 'local',
                hostId: 'local',
                restartCustody: {
                  kind: 'windows_daemon_job',
                  daemonPid: 4000,
                  daemonStartedAtMs: 1_786_000_000_000,
                  daemonLaunchNonce: 'new-worktree-test-daemon'
                }
              }
            } as never)
          : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: 'repo::parent',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::parent',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo',
      kind: 'git'
    } as never)
    vi.spyOn(runtime, 'createTerminal')
    vi.spyOn(runtime, 'listTerminals').mockImplementation(
      async () =>
        ({
          terminals: [{ handle: workerHandle, title: 'Codex' }],
          totalCount: 1,
          truncated: false
        }) as never
    )
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockReturnValue(
      new Promise(() => undefined)
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'resolveWorkerAgentProcessAdmission').mockReturnValue({
      targetFingerprint: 'c'.repeat(64)
    })
    vi.spyOn(runtime, 'createAgentSession').mockImplementation(async (request) => {
      const start = request.executionStart!
      workerHandle = start.terminalHandle
      return {
        terminal: {
          handle: workerHandle,
          worktreeId: request.worktree.replace(/^id:/, ''),
          title: 'Codex',
          surface: 'background'
        },
        disposition: 'created',
        executionStartReceipt: {
          ...start,
          launchTokenHash: 'test-launch-token-hash',
          paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          processIncarnation: 'runtime_test:term_worker:1',
          hostScope: {
            kind: 'local',
            hostId: 'local',
            restartCustody: {
              kind: 'windows_daemon_job',
              daemonPid: 4000,
              daemonStartedAtMs: 1_786_000_000_000,
              daemonLaunchNonce: 'new-worktree-test-daemon'
            }
          },
          providerSession: { key: 'session_id', id: 'codex-session' },
          turnStartedAt: Date.now(),
          semanticObservedAt: Date.now()
        }
      }
    })
  })

  afterEach(() => {
    db.close()
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  async function startWorker(overrides: Record<string, unknown> = {}) {
    const task = db.createTask({ spec: 'new-worktree task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      worktree: 'new-child',
      name: 'new-worker',
      agent: 'codex',
      ...overrides
    })
    const result = await method.handler(params, { runtime })
    return { result, task }
  }

  function mockCreatedWorktree(options?: {
    hookFound?: boolean
    startupPolicy?: 'start-immediately' | 'wait-for-setup'
    state?: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
    terminals?: { handle: string; title: string }[]
    setupTerminalHandle?: string
  }) {
    const hookFound = options?.hookFound ?? true
    const state = options?.state ?? (hookFound ? 'running' : 'not_configured')
    const defaultTerminals =
      options?.startupPolicy === 'wait-for-setup'
        ? [
            { handle: 'term_worker', title: 'Codex' },
            { handle: 'term_setup', title: 'Setup' }
          ]
        : [{ handle: 'term_worker', title: 'Codex' }]
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => {
      return {
        worktree: { id: 'repo::created', repoId: 'repo' },
        startupTerminal: { spawned: false },
        setupReceipt: {
          requested: state === 'skipped' ? 'skip' : 'run',
          hookFound,
          startupPolicy: options?.startupPolicy ?? 'start-immediately',
          state,
          terminalHandle:
            options?.setupTerminalHandle ??
            (options?.terminals ?? defaultTerminals).find((terminal) => terminal.title === 'Setup')
              ?.handle
        }
      } as never
    })
    vi.mocked(runtime.listTerminals).mockImplementation(async () => {
      const terminals = (options?.terminals ?? defaultTerminals).map((terminal) =>
        terminal.handle === 'term_worker' ? { ...terminal, handle: workerHandle } : terminal
      )
      return { terminals, totalCount: terminals.length, truncated: false } as never
    })
  }

  it('creates an independent top-level worktree and reuses its agent terminal', async () => {
    mockCreatedWorktree()

    const { result } = await startWorker({ worktree: 'new-top-level' })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressInitialTerminal: true,
        awaitTerminalProvisioning: true,
        observeSetupCompletion: true,
        lineage: expect.objectContaining({ noParent: true, parentWorktree: undefined })
      })
    )
    expect(result).toMatchObject({ state: 'ready' })
    expect(result).toHaveProperty(
      'effects',
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'worktree',
          action: 'created_top_level',
          id: 'repo::created'
        }),
        expect.objectContaining({
          kind: 'terminal',
          role: 'agent',
          action: 'created',
          id: workerHandle
        })
      ])
    )
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('passes launch preferences into the atomic Agent Session start', async () => {
    mockCreatedWorktree()

    const { result } = await startWorker({
      model: 'custom-claude-model',
      effort: 'high'
    })

    expect(runtime.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        launchPreferences: { model: 'custom-claude-model', effort: 'high' }
      }),
      { clientKind: 'runtime' }
    )
    expect(result).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'custom-claude-model', effort: 'high' },
        effective: { agent: 'codex', model: 'custom-claude-model', effort: 'high' }
      }
    })
  })

  it('rejects a new worktree for a folder project before creating effects', async () => {
    vi.mocked(runtime.showRepo).mockResolvedValue({
      id: 'repo',
      kind: 'folder'
    } as never)
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
    const task = db.createTask({ spec: 'folder task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }

    await expect(
      method.handler(
        method.params!.parse({
          task: task.id,
          from: 'term_coord',
          worktree: 'new-child',
          name: 'folder-worker',
          agent: 'codex'
        }),
        { runtime }
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        'Folder projects cannot create orchestration worktrees; use current or an exact existing folder workspace.'
    })
    expect(createWorktree).not.toHaveBeenCalled()
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('injects the execution host CLI command and Dispatch capability together', async () => {
    mockCreatedWorktree()
    vi.mocked(runtime.getTerminalOrchestrationCliCommand).mockReturnValue('orca-ide')

    await startWorker({ worktree: 'new-top-level' })

    const prompt = vi.mocked(runtime.createAgentSession).mock.calls[0]?.[0].prompt ?? ''
    expect(prompt).toContain('orca-ide orchestration send')
    expect(prompt).toMatch(/--dispatch-capability dcap_[A-Za-z0-9_-]+/)
    expect(prompt).not.toMatch(/(^|\s)orca orchestration send/)
  })

  it('passes exact repo, base, metadata, lineage, and setup choices to worktree creation', async () => {
    mockCreatedWorktree({ state: 'skipped' })

    await startWorker({
      worktree: 'new-top-level',
      repo: 'id:repo-explicit',
      baseBranch: 'origin/release',
      displayName: 'Windows release audit',
      comment: 'Created for a supervised audit',
      setup: 'skip'
    })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'id:repo-explicit',
        baseBranch: 'origin/release',
        displayName: 'Windows release audit',
        comment: 'Created for a supervised audit',
        setupDecision: 'skip',
        runHooks: false,
        lineage: expect.objectContaining({ noParent: true, parentWorktree: undefined })
      })
    )
  })

  it('reports an absent setup hook as not configured without failing the start', async () => {
    mockCreatedWorktree({ hookFound: false })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      state: 'ready',
      setup: {
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: false,
        state: 'not_configured'
      }
    })
  })

  it.each([
    ['skip', 'skipped'],
    ['inherit', 'not_configured'],
    ['run', 'running']
  ] as const)('passes explicit setup=%s through with a truthful receipt', async (setup, state) => {
    mockCreatedWorktree({ hookFound: setup === 'run', state })

    const { result } = await startWorker({ setup })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ setupDecision: setup, runHooks: false, activate: false })
    )
    expect(result).toMatchObject({
      state: 'ready',
      setup: { requested: setup, effective: setup, source: 'explicit_request', state }
    })
  })

  it('records a later setup failure without gating a start-immediately worker', async () => {
    mockCreatedWorktree({
      terminals: [
        { handle: 'term_worker', title: 'Codex' },
        { handle: 'term_setup', title: 'Setup' }
      ]
    })
    let finishSetup: ((result: { exitCode: number | null }) => void) | undefined
    vi.mocked(runtime.waitForSetupTerminalCompletion).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishSetup = resolve
        })
    )

    const { result, task } = await startWorker()
    const dispatchId = (result as { dispatchId: string }).dispatchId

    expect(result).toMatchObject({ state: 'ready', setup: { state: 'running' } })
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })
    finishSetup?.({ exitCode: 1 })
    await vi.waitFor(() => expect(db.getWorkerDispatch(dispatchId)?.setup_state).toBe('failed'))
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'succeeded',
      stage: 'settled',
      setup_state: 'failed'
    })
    expect(JSON.parse(db.getWorkerDispatch(dispatchId)?.effects ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    )
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
    expect(db.getInbox(10).filter((message) => message.run_id === runId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'status', priority: 'high' })])
    )
  })

  it('uses the exact setup handle instead of a configured tab title', async () => {
    mockCreatedWorktree({
      setupTerminalHandle: 'term_actual_setup',
      terminals: [
        { handle: 'term_worker', title: 'Codex' },
        { handle: 'term_configured_setup', title: 'Setup' },
        { handle: 'term_actual_setup', title: 'PowerShell' }
      ]
    })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      effects: expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal',
          id: 'term_configured_setup',
          role: 'configured_tab'
        }),
        expect.objectContaining({ kind: 'terminal', id: 'term_actual_setup', role: 'setup' }),
        expect.objectContaining({ kind: 'setup', terminalId: 'term_actual_setup' })
      ])
    })
  })

  it('records wait-for-setup success before task input is accepted', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'running' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_setup',
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 0
    })

    const { result } = await startWorker()
    const dispatchId = (result as { dispatchId: string }).dispatchId

    expect(result).toMatchObject({
      state: 'ready',
      setup: { startupPolicy: 'wait-for-setup', state: 'succeeded' },
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'setup', state: 'succeeded' }),
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    })
    expect(vi.mocked(runtime.waitForTerminal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.createAgentSession).mock.invocationCallOrder[0]!
    )
    expect(JSON.parse(db.getWorkerDispatch(dispatchId)?.effects ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    )
  })

  it('does not inject task input when the gated setup terminal fails to start', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'spawn_failed' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })

    const { result, task } = await startWorker()

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'setup_start',
      setup: { startupPolicy: 'wait-for-setup', state: 'spawn_failed' },
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'setup', state: 'spawn_failed' })
      ])
    })
    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('does not inject task input when the gated setup script fails', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'running' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'setup_wait',
      setup: { state: 'failed' },
      effects: expect.arrayContaining([expect.objectContaining({ kind: 'setup', state: 'failed' })])
    })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('does not mislabel a wait-for-setup timeout as setup failure', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'running' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'setup_wait',
      setup: { state: 'running' }
    })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('distinguishes no-effect failure, unknown acceptance, and durable residual effects', async () => {
    vi.spyOn(runtime, 'createManagedWorktree').mockRejectedValueOnce(
      new Error('repository validation failed before creation')
    )
    const noEffect = await startWorker({ name: 'no-effect' })
    expect(noEffect.result).toMatchObject({
      state: 'failed',
      failedStage: 'worktree_create',
      effects: [],
      residualResources: []
    })

    vi.mocked(runtime.createManagedWorktree).mockRejectedValueOnce(
      Object.assign(new Error('connection lost after possible acceptance'), {
        code: 'operation_unknown'
      })
    )
    const unknown = await startWorker({ name: 'unknown-effect' })
    expect(unknown.result).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'worktree_create',
      effects: [],
      residualResources: []
    })

    mockCreatedWorktree()
    vi.mocked(runtime.createAgentSession).mockRejectedValueOnce(
      new Error('provider rejected before process creation')
    )
    const durableEffect = await startWorker({ name: 'durable-effect' })
    expect(durableEffect.result).toMatchObject({
      state: 'failed',
      failedStage: 'execution_start',
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'worktree', id: 'repo::created' })
      ]),
      residualResources: expect.arrayContaining([
        expect.objectContaining({ kind: 'worktree', id: 'repo::created' })
      ])
    })
    expect(
      db.getWorkerTerminalResourceByOwner(
        (durableEffect.result as { dispatchId: string }).dispatchId
      )
    ).toBeUndefined()
  })

  it('returns outcome unknown when worktree creation may have been accepted remotely', async () => {
    vi.spyOn(runtime, 'createManagedWorktree').mockRejectedValue(
      Object.assign(new Error('connection closed after request acceptance'), {
        code: 'operation_unknown'
      })
    )

    const { result, task } = await startWorker()

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'worktree_create',
      nextCommands: expect.arrayContaining([
        expect.stringContaining('worker-show --dispatch'),
        expect.stringContaining('worker-abandon --dispatch')
      ])
    })
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('persists the retry request with the starting Dispatch before worktree effects', async () => {
    const task = db.createTask({ spec: 'atomic worker acceptance', runId })
    let finishCreate: ((value: CreateWorktreeResult) => void) | undefined
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => {
      return await new Promise((resolve) => {
        finishCreate = resolve
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const request: RpcRequest = {
      id: 'rpc_worker_start',
      authToken: 'caller-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'worker_start_request',
      method: 'orchestration.workerStart',
      params: {
        task: task.id,
        from: 'term_coord',
        worktree: 'new-child',
        name: 'atomic-worker',
        agent: 'codex'
      }
    }

    const pending = dispatcher.dispatch(request)
    await vi.waitFor(() => expect(db.getDispatchContext(task.id)).toBeDefined())
    const acceptedDispatch = db.getDispatchContext(task.id)!
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    const receipt = db.getMutationReceipt(callerFingerprint, 'worker_start_request')

    expect(receipt).toMatchObject({
      request_id: 'worker_start_request',
      method: 'orchestration.workerStart',
      state: 'pending'
    })
    expect(db.getWorkerDispatch(acceptedDispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'worktree_creating'
    })

    finishCreate?.({
      worktree: { id: 'repo::created', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: workerHandle },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    } as CreateWorktreeResult)
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { state: 'ready', mutation: { requestId: 'worker_start_request' } }
    })
    expect(db.getMutationReceipt(callerFingerprint, 'worker_start_request')).toMatchObject({
      state: 'completed'
    })
  })

  it('replays an execution-start failure after restart without creating another worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-start-replay-'))
    paths.push(dir)
    db.close()
    db = new OrchestrationDb(join(dir, 'orchestration.db'))
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Recover dispatch input',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    mockCreatedWorktree({ hookFound: false })
    vi.mocked(runtime.createAgentSession).mockRejectedValueOnce(
      new Error('provider rejected before execution start')
    )
    const task = db.createTask({ spec: 'recover dispatch input', runId })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const request: RpcRequest = {
      id: 'rpc_worker_start',
      authToken: 'caller-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'worker_start_request',
      method: 'orchestration.workerStart',
      params: {
        task: task.id,
        from: 'term_coord',
        worktree: 'new-child',
        name: 'recover-input-worker',
        agent: 'codex'
      }
    }

    const first = await dispatcher.dispatch(request)
    if (!first.ok) {
      throw new Error(`Initial worker start failed: ${first.error.code}`)
    }
    const firstReceipt = first.result as {
      dispatchId: string
      residualResources: unknown[]
    }
    db.close()

    db = new OrchestrationDb(join(dir, 'orchestration.db'))
    const restartedRuntime = new OrcaRuntimeService()
    restartedRuntime.setOrchestrationDb(db)
    vi.spyOn(restartedRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord_reminted'
        ? `tab_coord_reminted:${coordinatorPaneKey.split(':')[1]}`
        : null
    )
    const recreateWorktree = vi
      .spyOn(restartedRuntime, 'createManagedWorktree')
      .mockRejectedValue(new Error('replay recreated the worktree'))
    const recreateSession = vi
      .spyOn(restartedRuntime, 'createAgentSession')
      .mockRejectedValue(new Error('replay recreated the Session'))
    const restartedDispatcher = new RpcDispatcher({
      runtime: restartedRuntime,
      methods: ORCHESTRATION_METHODS
    })
    const replay = await restartedDispatcher.dispatch({
      ...request,
      id: 'rpc_worker_start_retry',
      authToken: 'caller-token-after-restart',
      params: { ...(request.params as Record<string, unknown>), from: 'term_coord_reminted' }
    })

    expect(first).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        failedStage: 'execution_start',
        residualResources: expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', id: 'repo::created' })
        ]),
        mutation: { requestId: 'worker_start_request', replayed: false }
      }
    })
    expect(replay).toMatchObject({
      ok: true,
      result: {
        dispatchId: firstReceipt.dispatchId,
        state: 'failed',
        failedStage: 'execution_start',
        residualResources: firstReceipt.residualResources,
        mutation: { requestId: 'worker_start_request', replayed: true }
      }
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
    expect(recreateWorktree).not.toHaveBeenCalled()
    expect(recreateSession).not.toHaveBeenCalled()
  })

  it('persists the execution-start claim before provider acceptance', async () => {
    mockCreatedWorktree({ hookFound: false })
    let finishSession:
      | ((value: Awaited<ReturnType<OrcaRuntimeService['createAgentSession']>>) => void)
      | undefined
    let request: Parameters<OrcaRuntimeService['createAgentSession']>[0] | undefined
    vi.mocked(runtime.createAgentSession).mockImplementationOnce(
      async (value) =>
        await new Promise((resolve) => {
          request = value
          finishSession = resolve
        })
    )

    const pending = startWorker({ name: 'staged-worker' })
    await vi.waitFor(() => {
      const task = db.listTasks()[0]
      const dispatch = task ? db.getDispatchContext(task.id) : undefined
      expect(dispatch && db.getWorkerDispatch(dispatch.id)).toMatchObject({
        state: 'starting',
        stage: 'worktree_created',
        worktree_id: 'repo::created'
      })
    })
    const dispatch = db.getDispatchContext(db.listTasks()[0]!.id)!
    expect(
      db.db
        .prepare(
          "SELECT state FROM worker_generation_operations WHERE dispatch_id = ? AND effect_kind = 'execution_start'"
        )
        .get(dispatch.id)
    ).toEqual({ state: 'claimed' })
    expect(db.getWorkerTerminalResourceByOwner(dispatch.id)).toBeUndefined()
    const start = request!.executionStart!
    workerHandle = start.terminalHandle
    finishSession?.({
      terminal: {
        handle: workerHandle,
        worktreeId: 'repo::created',
        title: 'Codex',
        surface: 'background'
      },
      disposition: 'created',
      executionStartReceipt: {
        ...start,
        launchTokenHash: 'test-launch-token-hash',
        paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        processIncarnation: 'runtime_test:term_worker:1',
        hostScope: {
          kind: 'local',
          hostId: 'local',
          restartCustody: {
            kind: 'windows_daemon_job',
            daemonPid: 4000,
            daemonStartedAtMs: 1_786_000_000_000,
            daemonLaunchNonce: 'new-worktree-test-daemon'
          }
        },
        providerSession: { key: 'session_id', id: 'codex-session' },
        turnStartedAt: Date.now(),
        semanticObservedAt: Date.now()
      }
    })
    await expect(pending).resolves.toMatchObject({
      result: { state: 'ready', stage: 'input_accepted' }
    })
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
  })
})
