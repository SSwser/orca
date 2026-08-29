import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import { executeAcceptedLocalWorkerStart } from './orchestration-worker-start-executor'
import { buildWorkerGenerationOperationIdentities } from './orchestration-worker-generation-identity'
import { prepareLocalWorkerExecution } from './orchestration-worker-start-preparation'
import { prepareWorkerExecutionAdmission } from './orchestration-worker-execution-admission'
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

  it('rejects a declared recovery caller that disagrees with attested evidence', async () => {
    const fixture = createFixture()
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      terminalHandle: 'term_attested',
      paneKey: 'tab_attested:leaf_attested',
      processIncarnation: 'runtime_test:attested:1',
      launchTokenHash: 'attested-launch-token-hash',
      hostScope: { kind: 'local', hostId: 'local' }
    })
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
        orchestrationCompatibilityEvidence: {
          terminalHandle: 'term_attested',
          paneKey: 'tab_attested:leaf_attested',
          launchToken: 'attested-launch-token'
        },
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'mismatched-caller',
          method: 'orchestration.workerRecover',
          payloadHash: 'mismatched-caller-hash'
        }
      })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
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
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => {
      return {
        worktree: { id: successorWorktreeId, repoId: 'repo' },
        startupTerminal: { spawned: false },
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
    const hostScope = {
      kind: 'local' as const,
      hostId: 'local',
      restartCustody: {
        kind: 'windows_daemon_job' as const,
        daemonPid: 9000,
        daemonStartedAtMs: 1_786_000_000_000,
        daemonLaunchNonce: 'recovery-test-daemon'
      }
    }
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle) =>
        ({
          terminalHandle: handle,
          paneKey:
            handle === 'term_coord' ? RECOVERY_TEST.coordinatorPane : RECOVERY_TEST.successorPane,
          processIncarnation:
            handle === 'term_coord' ? 'new-daemon:coord:process' : 'new-daemon:pty:process',
          hostScope
        }) as never
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'resolveWorkerAgentProcessAdmission').mockReturnValue({
      targetFingerprint: 'c'.repeat(64)
    })
    vi.spyOn(runtime, 'createAgentSession').mockImplementation(async (request) => {
      const start = request.executionStart!
      successorHandle = start.terminalHandle
      return {
        terminal: {
          handle: successorHandle,
          worktreeId: successorWorktreeId,
          title: 'Codex',
          surface: 'background'
        },
        disposition: 'created',
        executionStartReceipt: {
          ...start,
          launchTokenHash: 'test-launch-token-hash',
          paneKey: RECOVERY_TEST.successorPane,
          processIncarnation: 'new-daemon:pty:process',
          hostScope,
          providerSession: { key: 'session_id', id: 'codex-successor' },
          turnStartedAt: Date.now(),
          semanticObservedAt: Date.now()
        }
      }
    })
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
    const admission = prepareWorkerExecutionAdmission({
      runtime,
      task: fixture.task,
      coordinatorHandle: params.from,
      startOptions: prepared.startOptions,
      launchPreferences: prepared.launch.preferences
    })
    prepared.startOptions = admission.startOptions
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
      startOptions: admission.startOptions,
      successorDispatchId: admission.dispatchId,
      provisionalCapability: admission.provisionalCapability,
      launchTokenHash: admission.launchTokenHash,
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

  function completedWorktreeReceipt() {
    return {
      worktreeId: 'repo::successor',
      instanceId: 'successor-instance',
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
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
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
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
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
    vi.mocked(runtime.createAgentSession).mockClear()

    const replay = await method.handler(params, context)

    expect(replay).toMatchObject({ dispatchId: first.dispatchId, state: 'ready' })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })
  it('runs one successor effect chain for independent concurrent requests', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    let releaseWorktree!: () => void
    const worktreeGate = new Promise<void>((resolve) => {
      releaseWorktree = resolve
    })
    vi.mocked(runtime.createManagedWorktree).mockImplementation(async () => {
      await worktreeGate
      return {
        worktree: { id: 'repo::successor', repoId: 'repo' },
        startupTerminal: { spawned: false },
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
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
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
      state: 'starting',
      processAction: 'none'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
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
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
  })
  it('resumes an exact worktree owner result that was not persisted in the database', async () => {
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
    const ownerReceipt = completedWorktreeReceipt()
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
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
  })
  it('resumes a started successor execution without resending its first turn', async () => {
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
      receipt: completedWorktreeReceipt()
    })
    vi.mocked(runtime.createAgentSession).mockRejectedValueOnce(
      Object.assign(new Error('create reply lost after provider start'), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    )

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'outcome_unknown',
      stage: 'execution_start'
    })
    vi.mocked(runtime.getRuntimeId).mockReturnValue('restarted-runtime')
    vi.spyOn(runtime, 'inspectAgentSessionExecutionStart').mockResolvedValue({
      verdict: 'started',
      terminalHandle: operations.executionStart.terminalHandle,
      processIncarnation: 'new-daemon:pty:process'
    })

    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createAgentSession).toHaveBeenCalledTimes(2)
  })

  it('commits the exact accepted successor receipt with Worker authority', async () => {
    const fixture = createFixture()
    mockSuccessorRuntime()
    const accepted = await acceptPreparedSuccessor(fixture)
    const operations = buildWorkerGenerationOperationIdentities({
      dispatchId: accepted.started.dispatch.id,
      startOptions: accepted.prepared.startOptions
    })
    const worktreeReceipt = completedWorktreeReceipt()
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
      receipt: worktreeReceipt
    })
    await expect(executePreparedSuccessor(fixture, accepted)).resolves.toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
    expect(db.getWorkerTerminalResourceByOwner(accepted.started.dispatch.id)).toBeDefined()
    expect(
      db.db
        .prepare(
          "SELECT state FROM worker_generation_operations WHERE dispatch_id = ? AND effect_kind = 'execution_start'"
        )
        .get(accepted.started.dispatch.id)
    ).toEqual({ state: 'completed' })
  })

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
      expect(db.db.prepare('SELECT state FROM worker_execution_capacity_debts').get()).toEqual({
        state: 'withheld'
      })
    }
  )
})
