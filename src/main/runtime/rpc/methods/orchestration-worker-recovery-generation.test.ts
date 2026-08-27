import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'
const SUCCESSOR_PANE = 'tab_successor:33333333-3333-4333-8333-333333333333'
const REVISION = '0123456789abcdef0123456789abcdef01234567'
const HOST_SCOPE = {
  kind: 'local' as const,
  hostId: 'local' as const,
  restartCustody: {
    kind: 'windows_daemon_job' as const,
    daemonPid: 8100,
    daemonStartedAtMs: 1_786_000_000_000,
    daemonLaunchNonce: 'successor-generation-daemon'
  }
}

describe('orchestration.workerRecover successor generations', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })

  afterEach(() => db.close())

  function createSource() {
    const run = db.createRun({
      objective: 'recover successive worker generations',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE
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
      paneKey: 'tab_old:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'old-daemon:pty:process',
      hostScope: JSON.stringify(HOST_SCOPE),
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
    return { run, source, resource, delivery }
  }

  function mockRuntime(): void {
    let index = 0
    let terminalHandle = 'term_successor'
    let worktreeId = 'repo::successor-1'
    vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('current-runtime')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORDINATOR_PANE : SUCCESSOR_PANE
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) =>
        ({
          handle,
          worktreeId: handle === 'term_coord' ? 'repo::coordinator' : worktreeId,
          status: 'running'
        }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(
      async (selector) =>
        ({
          id: selector.slice('id:'.length),
          repoId: 'repo'
        }) as never
    )
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    vi.spyOn(runtime, 'resolveLocalManagedRepoCommit').mockResolvedValue(REVISION)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => undefined)
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
      index++
      terminalHandle = args.workerGenerationTerminalOperation?.terminalHandle ?? terminalHandle
      worktreeId = `repo::successor-${index}`
      return {
        worktree: { id: worktreeId, repoId: 'repo' },
        startupTerminal: { spawned: true, handle: terminalHandle },
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
          terminals: [{ handle: terminalHandle, title: 'Codex' }],
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
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      () =>
        ({
          terminalHandle,
          paneKey: SUCCESSOR_PANE,
          processIncarnation: `new-daemon:${terminalHandle}:process`,
          hostScope: HOST_SCOPE
        }) as never
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(
      async (handle, _prompt, options) => {
        await options?.beforeWrite?.(`pty-${handle}`)
        return { handle, accepted: true, bytesWritten: 1, semanticObservedAt: Date.now() }
      }
    )
  }

  async function recover(input: {
    dispatchId: string
    resourceId: string
    deliveryId: string
    name: string
    requestId: string
  }) {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerRecover'
    )!
    return (await method.handler(
      method.params!.parse({
        dispatch: input.dispatchId,
        resource: input.resourceId,
        delivery: input.deliveryId,
        resolution: 'retry_with_successor',
        revision: REVISION,
        worktree: 'new-child',
        name: input.name,
        agent: 'codex',
        from: 'term_coord',
        authorization: 'acknowledge_possible_duplicate_external_effects'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: input.requestId,
          method: 'orchestration.workerRecover',
          payloadHash: `${input.requestId}-hash`
        }
      }
    )) as { dispatchId: string; state: string; processAction: string }
  }

  it('contains an unverifiable failed successor and accepts one next generation', async () => {
    const fixture = createSource()
    mockRuntime()
    const first = await recover({
      dispatchId: fixture.source.dispatch.id,
      resourceId: fixture.resource.id,
      deliveryId: fixture.delivery.id,
      name: 'successor-generation-1',
      requestId: 'recover-source'
    })
    db.reconcileMissingWorkerTerminal(first.dispatchId, 'successor terminal missing')
    const failedResource = db.getWorkerTerminalResourceByOwner(first.dispatchId)!
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('unverifiable')
    const release = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerRelease'
    )!
    await release.handler(release.params!.parse({ dispatch: first.dispatchId }), { runtime })
    const failedDelivery = db.getOrCreateRunDelivery({
      runId: fixture.run.id,
      consumerGeneration: fixture.run.consumer_generation
    })!.delivery

    const next = await recover({
      dispatchId: first.dispatchId,
      resourceId: failedResource.id,
      deliveryId: failedDelivery.id,
      name: 'successor-generation-2',
      requestId: 'recover-failed-successor'
    })

    expect(next).toMatchObject({ state: 'ready', processAction: 'none' })
    expect(next.dispatchId).not.toBe(first.dispatchId)
    expect(db.getWorkerTerminalResource(failedResource.id)?.lifecycle_state).toBe('contained')
    expect(db.getDeliveryRaw(failedDelivery.id)?.status).toBe('contained')
    expect(
      db.db
        .prepare('SELECT resource_id, state FROM worker_terminal_capacity_debts ORDER BY rowid')
        .all()
    ).toEqual([
      { resource_id: fixture.resource.id, state: 'withheld' },
      { resource_id: failedResource.id, state: 'withheld' }
    ])
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(2)
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(2)
  })

  it('returns contained capacity exactly once after exact source-tree exit', async () => {
    const fixture = createSource()
    mockRuntime()
    await recover({
      dispatchId: fixture.source.dispatch.id,
      resourceId: fixture.resource.id,
      deliveryId: fixture.delivery.id,
      name: 'successor-generation-1',
      requestId: 'recover-source'
    })
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')
    const close = vi.spyOn(runtime, 'closeTerminal')
    const release = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerRelease'
    )!
    const params = release.params!.parse({ dispatch: fixture.source.dispatch.id })

    await expect(release.handler(params, { runtime })).resolves.toMatchObject({
      state: 'released',
      processAction: 'none'
    })
    await expect(release.handler(params, { runtime })).resolves.toMatchObject({
      state: 'already_released',
      processAction: 'none'
    })
    expect(close).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe('released')
    expect(db.db.prepare('SELECT state FROM worker_terminal_capacity_debts').get()).toEqual({
      state: 'released'
    })
  })
})
