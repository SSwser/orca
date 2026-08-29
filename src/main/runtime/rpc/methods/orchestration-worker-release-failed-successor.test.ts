import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const HOST_SCOPE = {
  kind: 'local' as const,
  hostId: 'local' as const,
  restartCustody: {
    kind: 'windows_daemon_job' as const,
    daemonPid: 4000,
    daemonStartedAtMs: 1_786_000_000_000,
    daemonLaunchNonce: 'failed-successor-daemon'
  }
}

describe('orchestration worker release after infrastructure failure', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let inspectProcessLiveness: ReturnType<typeof vi.fn>
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    inspectProcessLiveness = vi.fn().mockResolvedValue('live')
    ;(
      runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: typeof inspectProcessLiveness
      }
    ).inspectTerminalProcessIncarnationLiveness = inspectProcessLiveness
    vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('runtime-test')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORDINATOR_PANE : WORKER_PANE
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'runtime_test:term_worker:1',
      hostScope: HOST_SCOPE
    } as never)
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: true
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => undefined)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: 'repo::coordinator',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::coordinator',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::coordinator'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => undefined)
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'resolveWorkerAgentProcessAdmission').mockReturnValue({
      targetFingerprint: 'c'.repeat(64)
    })
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({ handle: 'term_retry' } as never)
    runId = db.createRun({
      objective: 'failed successor release',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE
    }).id
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function createWorker() {
    const task = db.createTask({ spec: 'failed successor', runId })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'runtime_test:term_worker:1',
      hostScope: JSON.stringify(HOST_SCOPE),
      worktreeId: 'repo::failed-generation',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { taskId: task.id, dispatchId: started.dispatch.id }
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)!
    return method.handler(method.params!.parse(params), { runtime })
  }

  function abandon(dispatchId: string): void {
    db.abandonWorkerDispatch(dispatchId)
    db.db
      .prepare(`UPDATE worker_dispatches SET stage = 'terminal_missing' WHERE dispatch_id = ?`)
      .run(dispatchId)
  }

  it('releases an abandoned terminal-missing worker from exact restart-custody exit', async () => {
    const { dispatchId } = createWorker()
    abandon(dispatchId)
    inspectProcessLiveness.mockResolvedValue('exited')
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
      handle === 'term_coord'
        ? ({
            terminalHandle: handle,
            paneKey: COORDINATOR_PANE,
            processIncarnation: 'runtime_test:term_coord:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
    expect(inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify(HOST_SCOPE)
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it.each(['stopped', 'abandoned'] as const)(
    'preserves the archive while settling a %s worker from exact process absence',
    async (state) => {
      const { dispatchId } = createWorker()
      const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
      db.storeWorkerTerminalArchive({
        dispatchId,
        resourceId: resource.id,
        kind: 'terminal_tail',
        content: '{"lines":["preserved before terminal loss"]}'
      })
      if (state === 'stopped') {
        db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
        db.settleWorkerStop(dispatchId)
      } else {
        abandon(dispatchId)
      }
      inspectProcessLiveness.mockResolvedValue('exited')

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
      expect(runtime.closeTerminal).not.toHaveBeenCalled()
      expect(db.getWorkerTerminalArchive(dispatchId)?.content).toContain(
        'preserved before terminal loss'
      )
    }
  )

  it('creates one fenced settlement Delivery and blocks ordinary retry while unverifiable', async () => {
    const { taskId, dispatchId } = createWorker()
    abandon(dispatchId)
    inspectProcessLiveness.mockResolvedValue('unverifiable')
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
      handle === 'term_coord'
        ? ({
            terminalHandle: handle,
            paneKey: COORDINATOR_PANE,
            processIncarnation: 'runtime_test:term_coord:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )

    const receipts = await Promise.all([
      call('orchestration.workerRelease', { dispatch: dispatchId }),
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ])
    expect(receipts).toEqual([
      expect.objectContaining({ state: 'release_unknown', processAction: 'none' }),
      expect.objectContaining({ state: 'release_unknown', processAction: 'none' })
    ])
    expect(
      db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE from_handle = 'system:worker-release'"
        )
        .get()
    ).toEqual({ count: 1 })
    await expect(
      call('orchestration.workerStart', {
        task: taskId,
        retryOf: dispatchId,
        from: 'term_coord',
        agent: 'codex'
      })
    ).rejects.toMatchObject({ code: 'terminal_resource_unsettled' })
    expect(runtime.createTerminal).not.toHaveBeenCalled()

    const delivery = (await call('orchestration.check', {
      terminal: 'term_coord',
      terminalPaneKey: COORDINATOR_PANE
    })) as { deliveryId: string; count: number; messages: { type: string }[] }
    expect(delivery).toMatchObject({ count: 1, messages: [{ type: 'status' }] })
    await expect(
      call('orchestration.check', {
        terminal: 'term_coord',
        terminalPaneKey: COORDINATOR_PANE,
        ack: delivery.deliveryId
      })
    ).rejects.toMatchObject({ code: 'terminal_resource_unsettled' })
  })

  it('recovers the settlement message after release_unknown committed first', async () => {
    const { dispatchId } = createWorker()
    abandon(dispatchId)
    inspectProcessLiveness.mockResolvedValue('unverifiable')
    expect(db.requestWorkerTerminalRelease(dispatchId)).toMatchObject({
      disposition: 'reconcile_settled'
    })

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
    const delivery = (await call('orchestration.check', {
      terminal: 'term_coord',
      terminalPaneKey: COORDINATOR_PANE
    })) as { count: number; messages: { type: string }[] }
    expect(delivery).toMatchObject({ count: 1, messages: [{ type: 'status' }] })
  })

  it('takes no process action for a live abandoned worker with conflicting authority', async () => {
    const { dispatchId } = createWorker()
    abandon(dispatchId)
    inspectProcessLiveness.mockResolvedValue('live')
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue({
      terminalHandle: 'term_other',
      paneKey: 'tab_other:leaf_other',
      processIncarnation: 'other-runtime:other-pty:1',
      hostScope: HOST_SCOPE
    } as never)

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'none',
      recovery: expect.stringContaining('no process action')
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })
})
