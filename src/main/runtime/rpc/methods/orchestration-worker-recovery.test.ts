import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import { executeAcceptedLocalWorkerStart } from './orchestration-worker-start-executor'
import { buildWorkerGenerationOperationIdentities } from './orchestration-worker-generation-identity'
import { prepareLocalWorkerExecution } from './orchestration-worker-start-preparation'
import { RECOVERY_TEST } from './orchestration-worker-recovery-test-constants'

describe('orchestration.workerRecover', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })

  afterEach(() => db.close())

  function createFixture() {
    const run = db.createRun({
      objective: 'recover worker generation',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: RECOVERY_TEST.coordinatorPane
    })
    const task = db.createTask({ spec: 'repeat the logical task', runId: run.id })
    const source = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: source.dispatch.id,
      handle: 'term_old',
      paneKey: RECOVERY_TEST.workerPane,
      processIncarnation: 'old-daemon:pty:process',
      hostScope: RECOVERY_TEST.sourceRestartScope,
      worktreeId: 'repo::old-generation',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(source.dispatch.id)
    db.settleWorkerReport({
      taskId: task.id,
      dispatchId: source.dispatch.id,
      outcome: 'succeeded',
      result: 'source result'
    })
    const resource = db.getWorkerTerminalResourceByOwner(source.dispatch.id)!
    db.storeWorkerTerminalArchive({
      dispatchId: source.dispatch.id,
      resourceId: resource.id,
      kind: 'terminal_tail',
      content: '{"lines":["source result"]}'
    })
    db.requestWorkerTerminalRelease(source.dispatch.id)
    db.markWorkerTerminalReleaseUnknown(resource.id, 'old daemon custody lost')
    db.insertMessage({
      from: 'term_old',
      to: `run:${run.id}`,
      subject: 'source done',
      type: 'worker_done',
      runId: run.id,
      payload: JSON.stringify({ taskId: task.id, dispatchId: source.dispatch.id })
    })
    const delivery = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!.delivery
    return { run, task, source, resource, delivery }
  }

  it('accepts an authoritative archive without successor effects', async () => {
    const fixture = createFixture()
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(RECOVERY_TEST.coordinatorPane)
    const resolveRevision = vi.spyOn(runtime, 'resolveLocalManagedRepoCommit')
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const sendPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerRecover'
    )!
    const params = method.params!.parse({
      dispatch: fixture.source.dispatch.id,
      resource: fixture.resource.id,
      delivery: fixture.delivery.id,
      resolution: 'accept_archived_result',
      from: 'term_coord',
      authorization: 'accept_authoritative_archived_result_with_lost_custody'
    })

    await expect(
      method.handler(params, {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'accept-archive',
          method: 'orchestration.workerRecover',
          payloadHash: 'accept-archive-hash'
        }
      })
    ).resolves.toMatchObject({
      state: 'contained',
      processAction: 'none',
      recoveryDisposition: 'accept_archived_result',
      successorDispatchId: null
    })
    expect(resolveRevision).not.toHaveBeenCalled()
    expect(createWorktree).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })
  function mockSuccessorRuntime() {
    let successorHandle = 'term_successor'
    let successorWorktreeId = 'repo::successor'
    vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('current-runtime')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? RECOVERY_TEST.coordinatorPane
        : handle === successorHandle
          ? RECOVERY_TEST.successorPane
          : null
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) =>
        (handle === 'term_coord'
          ? { handle, worktreeId: 'repo::coordinator', status: 'running' }
          : { handle, worktreeId: successorWorktreeId, status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(
      async (selector) =>
        ({
          id: selector.startsWith('id:repo::successor')
            ? selector.slice('id:'.length)
            : 'repo::coordinator',
          repoId: 'repo'
        }) as never
    )
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    vi.spyOn(runtime, 'resolveLocalManagedRepoCommit').mockResolvedValue(RECOVERY_TEST.revision)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => undefined)
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
      successorHandle = args.workerGenerationTerminalOperation?.terminalHandle ?? successorHandle
      return {
        worktree: { id: successorWorktreeId, repoId: 'repo' },
        startupTerminal: { spawned: true, handle: successorHandle },
        setupReceipt: {
          requested: 'run',
          hookFound: false,
          startupPolicy: 'start-immediately',
          state: 'not_configured'
        }
      } as never
    })
    vi.spyOn(runtime, 'listTerminals').mockImplementation(
      async () =>
        ({
          terminals: [{ handle: successorHandle, title: 'Codex' }],
          totalCount: 1,
          truncated: false
        }) as never
    )
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_successor',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: successorHandle,
      paneKey: RECOVERY_TEST.successorPane,
      processIncarnation: 'new-daemon:pty:process',
      hostScope: {
        kind: 'local',
        hostId: 'local',
        restartCustody: {
          kind: 'windows_daemon_job',
          daemonPid: 9000,
          daemonStartedAtMs: 1_786_000_000_000,
          daemonLaunchNonce: 'recovery-test-daemon'
        }
      }
    } as never)
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(
      async (handle, _prompt, options) => {
        options?.beforeWrite?.('pty-successor')
        return { handle, accepted: true, bytesWritten: 1, semanticObservedAt: Date.now() }
      }
    )
    return {
      get successorHandle() {
        return successorHandle
      },
      get successorWorktreeId() {
        return successorWorktreeId
      }
    }
  }

  function invocation(fixture: ReturnType<typeof createFixture>) {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerRecover'
    )!
    const params = method.params!.parse({
      dispatch: fixture.source.dispatch.id,
      resource: fixture.resource.id,
      delivery: fixture.delivery.id,
      resolution: 'retry_with_successor',
      revision: RECOVERY_TEST.revision,
      worktree: 'new-child',
      name: 'successor-generation',
      agent: 'codex',
      from: 'term_coord',
      authorization: 'acknowledge_possible_duplicate_external_effects'
    })
    const context = {
      runtime,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'recover-request',
        method: 'orchestration.workerRecover',
        payloadHash: 'payload-hash'
      }
    }
    return { method, params, context }
  }

  async function acceptPreparedSuccessor(fixture: ReturnType<typeof createFixture>) {
    const params = {
      task: fixture.task.id,
      run: fixture.run.id,
      from: 'term_coord',
      worktree: 'new-child' as const,
      name: 'successor-generation',
      baseBranch: RECOVERY_TEST.revision,
      agent: 'codex'
    }
    const prepared = await prepareLocalWorkerExecution({ runtime, params })
    const accepted = db.acceptLostCustodyWorkerRecovery({
      runId: fixture.run.id,
      consumerGeneration: fixture.run.consumer_generation,
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: RECOVERY_TEST.coordinatorPane,
      sourceDispatchId: fixture.source.dispatch.id,
      sourceResourceId: fixture.resource.id,
      sourceDeliveryId: fixture.delivery.id,
      recoveryDisposition: 'retry_with_successor',
      trustedRevision: RECOVERY_TEST.revision,
      successorPlacement: 'new-child',
      successorName: 'successor-generation',
      authorization: 'acknowledge_possible_duplicate_external_effects',
      startOptions: prepared.startOptions,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'crash-seam-caller',
        requestId: `crash-seam-${fixture.source.dispatch.id}`,
        method: 'orchestration.workerRecover',
        payloadHash: 'crash-seam-payload'
      }
    })
    return { prepared, started: accepted.successor }
  }

  function completedWorktreeReceipt(
    operations: ReturnType<typeof buildWorkerGenerationOperationIdentities>
  ) {
    return {
      worktreeId: 'repo::successor',
      instanceId: 'successor-instance',
      terminalHandle: operations.terminal.terminalHandle,
      setup: {
        requested: 'run' as const,
        effective: 'run' as const,
        source: 'orchestration_default',
        hookFound: false,
        startupPolicy: 'start-immediately' as const,
        state: 'not_configured' as const
      }
    }
  }

  async function executePreparedSuccessor(
    fixture: ReturnType<typeof createFixture>,
    accepted: Awaited<ReturnType<typeof acceptPreparedSuccessor>>
  ) {
    return executeAcceptedLocalWorkerStart({
      runtime,
      db,
      runId: fixture.run.id,
      task: fixture.task,
      started: accepted.started,
      prepared: accepted.prepared
    })
  }
  it('contains without process action and runs the successor through the shared executor', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    const { method, params, context } = invocation(fixture)

    const result = (await method.handler(params, context)) as Record<string, unknown>

    expect(result).toMatchObject({
      state: 'ready',
      processAction: 'none',
      containment: { deliveryResolution: 'contained', capacity: 'withheld' }
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: RECOVERY_TEST.revision })
    )
    expect(runtime.createManagedWorktree).not.toHaveBeenCalledWith(
      expect.objectContaining({ repoSelector: 'repo::old-generation' })
    )
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(db.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe('contained')
    expect(db.getDeliveryRaw(fixture.delivery.id)?.status).toBe('contained')
    const successor = db.getWorkerDispatch(result.dispatchId as string)!
    expect(successor.worktree_id).toBe('repo::successor')
    expect(
      db.db.prepare('SELECT successor_worktree_id FROM worker_lost_custody_recoveries').get()
    ).toEqual({ successor_worktree_id: 'repo::successor' })
    const show = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerShow'
    )!
    await expect(
      show.handler(show.params!.parse({ dispatch: fixture.source.dispatch.id }), { runtime })
    ).resolves.toMatchObject({
      terminalResource: { lifecycleState: 'contained' },
      containment: {
        sourceDeliveryId: fixture.delivery.id,
        successorDispatchId: result.dispatchId,
        successorWorktreeId: 'repo::successor',
        capacityState: 'withheld'
      }
    })
    const list = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerList'
    )!
    expect(list.handler(list.params!.parse({}), { runtime })).toMatchObject({
      workers: expect.arrayContaining([
        expect.objectContaining({
          dispatchId: fixture.source.dispatch.id,
          terminalState: 'contained',
          containment: expect.objectContaining({ capacityState: 'withheld' })
        })
      ])
    })
    const retain = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerRetain'
    )!
    expect(
      retain.handler(retain.params!.parse({ dispatch: fixture.source.dispatch.id }), {
        runtime
      })
    ).toMatchObject({ state: 'contained', processAction: 'none' })
  })
  it('rejects an unresolved revision before containment or external effects', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    vi.mocked(runtime.resolveLocalManagedRepoCommit).mockRejectedValue(
      new Error('revision missing')
    )
    const { method, params, context } = invocation(fixture)

    await expect(method.handler(params, context)).rejects.toThrow('revision missing')
    expect(db.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe(
      'release_unknown'
    )
    expect(db.getDeliveryRaw(fixture.delivery.id)?.status).toBe('outstanding')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('rejects the lost-custody physical workspace before containment or Git resolution', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    vi.mocked(runtime.showManagedWorktree).mockResolvedValue({
      id: 'repo::old-generation',
      repoId: 'repo'
    } as never)
    const { method, params, context } = invocation(fixture)

    await expect(method.handler(params, context)).rejects.toMatchObject({
      code: 'terminal_resource_unsettled'
    })
    expect(runtime.resolveLocalManagedRepoCommit).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe(
      'release_unknown'
    )
  })
  it('replays a completed successor without another worktree or prompt effect', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    const { method, params, context } = invocation(fixture)
    const first = (await method.handler(params, context)) as Record<string, unknown>
    vi.mocked(runtime.createManagedWorktree).mockClear()
    vi.mocked(runtime.sendTerminalAgentPrompt).mockClear()

    const replay = await method.handler(params, context)

    expect(replay).toMatchObject({ dispatchId: first.dispatchId, state: 'ready' })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('runs one successor effect chain for independent concurrent requests', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    let releaseWorktree!: () => void
    const worktreeGate = new Promise<void>((resolve) => {
      releaseWorktree = resolve
    })
    vi.mocked(runtime.createManagedWorktree).mockImplementation(async (args) => {
      await worktreeGate
      const handle = args.workerGenerationTerminalOperation!.terminalHandle
      return {
        worktree: { id: 'repo::successor', repoId: 'repo' },
        startupTerminal: { spawned: true, handle },
        setupReceipt: {
          requested: 'run',
          hookFound: false,
          startupPolicy: 'start-immediately',
          state: 'not_configured'
        }
      } as never
    })
    const first = invocation(fixture)
    const second = invocation(fixture)
    second.context.orchestrationMutation.requestId = 'recover-request-independent'

    const firstResult = first.method.handler(first.params, first.context)
    await vi.waitFor(() => expect(runtime.createManagedWorktree).toHaveBeenCalledOnce())
    const secondResult = await second.method.handler(second.params, second.context)
    releaseWorktree()

    await expect(firstResult).resolves.toMatchObject({ state: 'ready' })
    expect(secondResult).toMatchObject({
      state: 'starting',
      stage: 'worktree_operation_in_progress',
      processAction: 'none'
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM worker_dispatches').get()).toEqual({
      count: 2
    })
  })
  it('does not duplicate a successor generation after an ambiguous worktree effect', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    vi.mocked(runtime.createManagedWorktree).mockRejectedValue(
      new Error('connection lost; outcome unknown')
    )
    const { method, params, context } = invocation(fixture)

    await expect(method.handler(params, context)).resolves.toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'worktree_create'
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    vi.mocked(runtime.createManagedWorktree).mockClear()

    await expect(method.handler(params, context)).resolves.toMatchObject({
      state: 'outcome_unknown',
      processAction: 'none'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('resumes when only the worktree claim was persisted', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    const accepted = await acceptPreparedSuccessor(fixture)
    const operations = buildWorkerGenerationOperationIdentities({
      dispatchId: accepted.started.dispatch.id,
      startOptions: accepted.prepared.startOptions
    })
    db.claimWorkerGenerationOperation({
      dispatchId: accepted.started.dispatch.id,
      effectKind: 'worktree',
      ...operations.worktree,
      claimantId: 'prior-runtime:worktree'
    })
    const inspect = vi.spyOn(runtime, 'inspectManagedWorkerGenerationOperation').mockResolvedValue({
      verdict: 'not_started'
    })

    const result = await executePreparedSuccessor(fixture, accepted)
    expect(inspect).toHaveBeenCalledOnce()
    expect(
      db.db
        .prepare(
          "SELECT claimant_id FROM worker_generation_operations WHERE effect_kind = 'worktree'"
        )
        .get()
    ).toEqual({ claimant_id: expect.stringContaining('current-runtime') })
    expect(result).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })
  it('resumes an exact worktree owner result that was not persisted in the database', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    const accepted = await acceptPreparedSuccessor(fixture)
    const operations = buildWorkerGenerationOperationIdentities({
      dispatchId: accepted.started.dispatch.id,
      startOptions: accepted.prepared.startOptions
    })
    for (const effectKind of ['worktree', 'terminal'] as const) {
      db.claimWorkerGenerationOperation({
        dispatchId: accepted.started.dispatch.id,
        effectKind,
        ...operations[effectKind],
        claimantId: `prior-runtime:${effectKind}`
      })
    }
    const ownerReceipt = completedWorktreeReceipt(operations)
    vi.spyOn(runtime, 'inspectManagedWorkerGenerationOperation').mockResolvedValue({
      verdict: 'completed',
      worktree: { id: 'repo::successor', repoId: 'repo' } as never,
      receipt: {
        ...ownerReceipt,
        setup: {
          requested: 'run',
          hookFound: false,
          startupPolicy: 'start-immediately',
          state: 'not_configured'
        }
      }
    })

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })
  it('resumes exact terminal custody that was not persisted in the database', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    const accepted = await acceptPreparedSuccessor(fixture)
    const operations = buildWorkerGenerationOperationIdentities({
      dispatchId: accepted.started.dispatch.id,
      startOptions: accepted.prepared.startOptions
    })
    db.claimWorkerGenerationOperation({
      dispatchId: accepted.started.dispatch.id,
      effectKind: 'worktree',
      ...operations.worktree,
      claimantId: 'prior-runtime:worktree'
    })
    db.completeWorkerGenerationOperation({
      dispatchId: accepted.started.dispatch.id,
      effectKind: 'worktree',
      ...operations.worktree,
      claimantId: 'prior-runtime:worktree',
      receipt: completedWorktreeReceipt(operations)
    })
    db.claimWorkerGenerationOperation({
      dispatchId: accepted.started.dispatch.id,
      effectKind: 'terminal',
      ...operations.terminal,
      claimantId: 'prior-runtime:terminal'
    })
    const ownerReceipt = completedWorktreeReceipt(operations)
    vi.spyOn(runtime, 'inspectManagedWorkerGenerationOperation').mockResolvedValue({
      verdict: 'completed',
      worktree: { id: 'repo::successor', repoId: 'repo' } as never,
      receipt: {
        ...ownerReceipt,
        setup: {
          requested: 'run',
          hookFound: false,
          startupPolicy: 'start-immediately',
          state: 'not_configured'
        }
      }
    })

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })

  it('resumes after authority and its durable receipt commit atomically', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    const accepted = await acceptPreparedSuccessor(fixture)
    const operations = buildWorkerGenerationOperationIdentities({
      dispatchId: accepted.started.dispatch.id,
      startOptions: accepted.prepared.startOptions
    })
    const worktreeReceipt = completedWorktreeReceipt(operations)
    for (const [effectKind, identity, receipt] of [
      ['worktree', operations.worktree, worktreeReceipt],
      [
        'terminal',
        operations.terminal,
        {
          terminalHandle: operations.terminal.terminalHandle,
          worktreeId: 'repo::successor',
          paneKey: RECOVERY_TEST.successorPane,
          processIncarnation: 'new-daemon:pty:process',
          hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
        }
      ]
    ] as const) {
      db.claimWorkerGenerationOperation({
        dispatchId: accepted.started.dispatch.id,
        effectKind,
        ...identity,
        claimantId: `prior-runtime:${effectKind}`
      })
      db.completeWorkerGenerationOperation({
        dispatchId: accepted.started.dispatch.id,
        effectKind,
        ...identity,
        claimantId: `prior-runtime:${effectKind}`,
        receipt
      })
    }
    db.claimWorkerGenerationOperation({
      dispatchId: accepted.started.dispatch.id,
      effectKind: 'authority',
      ...operations.authority,
      claimantId: 'prior-runtime:authority'
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: accepted.started.dispatch.id,
      handle: operations.terminal.terminalHandle,
      paneKey: RECOVERY_TEST.successorPane,
      processIncarnation: 'new-daemon:pty:process',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      worktreeId: 'repo::successor',
      effects: [],
      setupState: 'not_configured',
      terminalOwnership: 'created',
      generationOperation: { ...operations.authority, claimantId: 'prior-runtime:authority' }
    })

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(
      db.readWorkerGenerationOperation({
        dispatchId: accepted.started.dispatch.id,
        effectKind: 'authority',
        ...operations.authority
      })
    ).toMatchObject({ verdict: 'completed' })
  })

  it('does not complete prompt acceptance when the first PTY write fails', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    vi.mocked(runtime.sendTerminalAgentPrompt).mockImplementation(
      async (_handle, _prompt, options) => {
        await options?.beforeWrite?.('pty-successor')
        throw new Error('terminal_not_writable')
      }
    )
    const accepted = await acceptPreparedSuccessor(fixture)

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'dispatch_input'
    })
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    const prompt = db.db
      .prepare(
        "SELECT state, receipt FROM worker_generation_operations WHERE dispatch_id = ? AND effect_kind = 'prompt'"
      )
      .get(accepted.started.dispatch.id) as { state: string; receipt: string | null }
    expect(prompt).toEqual({ state: 'claimed', receipt: null })
    expect(db.getWorkerDispatch(accepted.started.dispatch.id)).toMatchObject({
      state: 'failed',
      stage: 'dispatch_input'
    })
  })

  it('does not complete prompt acceptance after only a prompt prefix is written', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    vi.mocked(runtime.sendTerminalAgentPrompt).mockImplementation(
      async (_handle, _prompt, options) => {
        await options?.beforeWrite?.('pty-successor')
        await options?.beforeWrite?.('pty-successor')
        throw Object.assign(new Error('prompt write outcome unknown'), {
          code: 'operation_unknown'
        })
      }
    )
    const accepted = await acceptPreparedSuccessor(fixture)

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'outcome_unknown'
    })
    expect(
      db.db
        .prepare(
          "SELECT state, receipt FROM worker_generation_operations WHERE dispatch_id = ? AND effect_kind = 'prompt'"
        )
        .get(accepted.started.dispatch.id)
    ).toEqual({ state: 'claimed', receipt: null })
    expect(db.getWorkerDispatch(accepted.started.dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'dispatch_input'
    })
    vi.mocked(runtime.sendTerminalAgentPrompt).mockClear()

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'outcome_unknown',
      processAction: 'none'
    })
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('resumes semantic prompt observation after restart without rewriting transport', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    vi.mocked(runtime.sendTerminalAgentPrompt).mockRejectedValueOnce(
      Object.assign(new Error('prompt reply lost'), { code: 'operation_unknown' })
    )
    const accepted = await acceptPreparedSuccessor(fixture)

    await executePreparedSuccessor(fixture, accepted)
    vi.mocked(runtime.getRuntimeId).mockReturnValue('restarted-runtime')
    vi.mocked(runtime.sendTerminalAgentPrompt).mockClear()
    const unconfirmed = Object.assign(new Error('submission_unconfirmed'), {
      code: 'submission_unconfirmed'
    })
    const inspect = vi
      .spyOn(runtime, 'inspectTerminalWorkerPromptOperation')
      .mockRejectedValue(unconfirmed)

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'dispatch_input',
      lastError: 'submission_unconfirmed'
    })
    expect(inspect).toHaveBeenCalledOnce()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it.each([
    ['not_started', 'ready', 1],
    ['completed', 'ready', 0],
    ['conflict', 'failed', 0],
    ['unverifiable', 'outcome_unknown', 0]
  ] as const)(
    'applies the exact prompt owner %s readback without blind resend',
    async (verdict, expectedState, expectedWrites) => {
      const fixture = createFixture()
      mockSuccessorRuntime()
      vi.mocked(runtime.sendTerminalAgentPrompt).mockRejectedValueOnce(
        Object.assign(new Error('prompt reply lost'), { code: 'operation_unknown' })
      )
      const accepted = await acceptPreparedSuccessor(fixture)
      await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
        state: 'outcome_unknown',
        failedStage: 'dispatch_input'
      })
      vi.mocked(runtime.getRuntimeId).mockReturnValue('restarted-runtime')
      vi.mocked(runtime.sendTerminalAgentPrompt).mockClear()
      vi.mocked(runtime.sendTerminalAgentPrompt).mockResolvedValue({
        handle: 'term_successor',
        accepted: true,
        bytesWritten: 1,
        semanticObservedAt: Date.now()
      })
      vi.spyOn(runtime, 'inspectTerminalWorkerPromptOperation').mockResolvedValue(
        verdict === 'completed'
          ? ({
              verdict,
              receipt: {
                operationId: 'prompt-operation',
                payloadFingerprint: 'prompt-fingerprint',
                sessionIncarnationId: 'new-daemon:pty:process',
                terminalHandle: 'term_successor',
                completedAt: Date.now(),
                semanticObservedAt: Date.now()
              }
            } as never)
          : { verdict }
      )

      await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
        state: expectedState,
        ...(verdict === 'unverifiable' ? { stage: 'prompt_operation_in_progress' } : {})
      })
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(expectedWrites)
    }
  )

  it.each(['live', 'unverifiable'] as const)(
    'keeps contained capacity withheld without process action when liveness is %s',
    async (liveness) => {
      const fixture = createFixture()
      mockSuccessorRuntime()
      const recovery = invocation(fixture)
      await recovery.method.handler(recovery.params, recovery.context)
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue(liveness)
      const close = vi.spyOn(runtime, 'closeTerminal')
      const release = ORCHESTRATION_METHODS.find(
        (candidate) => candidate.name === 'orchestration.workerRelease'
      )!

      await expect(
        release.handler(release.params!.parse({ dispatch: fixture.source.dispatch.id }), {
          runtime
        })
      ).resolves.toMatchObject({ state: 'contained', processAction: 'none' })
      expect(close).not.toHaveBeenCalled()
      expect(db.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe('contained')
      expect(db.db.prepare('SELECT state FROM worker_terminal_capacity_debts').get()).toEqual({
        state: 'withheld'
      })
    }
  )
})
