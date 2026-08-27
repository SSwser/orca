import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { defineMethod, type RpcContext, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { withWorkerRecoveryFinality } from './methods/orchestration-worker-recovery'

const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const processIncarnation = 'runtime_test:term_worker:1'
const hostScope = {
  kind: 'local' as const,
  hostId: 'local' as const,
  restartCustody: {
    kind: 'windows_daemon_job' as const,
    daemonPid: 4000,
    daemonStartedAtMs: 1_786_000_000_000,
    daemonLaunchNonce: 'mutation-finality-daemon'
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('worker-release durable mutation finality', () => {
  const tempPaths: string[] = []
  const openDbs: OrchestrationDb[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of openDbs.splice(0)) {
      try {
        db.close()
      } catch {}
    }
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('keeps a non-final workerRecover receipt pending through RpcDispatcher replay state', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'orchestration.workerRecover',
          params: z.object({ dispatch: z.string() }),
          handler: withWorkerRecoveryFinality(async () => ({ state: 'outcome_unknown' }))
        })
      ]
    })
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          method: 'orchestration.workerRecover',
          params: { dispatch: 'ctx_recovery' }
        })
      )
      .digest('hex')
    db.beginMutationReceipt({
      callerFingerprint,
      requestId: 'recover-finality',
      method: 'orchestration.workerRecover',
      payloadHash
    })
    const response = await dispatcher.dispatch({
      id: 'rpc_recover_finality',
      authToken: 'caller-token',
      method: 'orchestration.workerRecover',
      params: { dispatch: 'ctx_recovery' },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'recover-finality'
    })
    expect(response).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
    expect(db.getMutationReceipt(callerFingerprint, 'recover-finality')).toMatchObject({
      state: 'pending'
    })
    db.close()
  })

  it('re-enters exact reconciliation after restart with the same request identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-release-finality-'))
    tempPaths.push(dir)
    const dbPath = join(dir, 'orchestration.db')
    const first = createHarness(dbPath, 'unverifiable', openDbs)
    const dispatchId = await createSettledWorker(first)
    vi.mocked(first.runtime.closeTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      tabId: 'tab_worker',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'the daemon reply was lost'
    })
    const request = releaseRequest(dispatchId)

    const uncertain = await first.dispatcher.dispatch(request)
    const caller = first.db.getOrCreateLocalMutationCallerFingerprint()
    expect(uncertain).toMatchObject({
      ok: true,
      result: {
        state: 'release_unknown',
        processAction: 'none',
        archive: { status: 'captured' },
        mutation: { requestId: 'release-restart', replayed: false }
      }
    })
    expect(first.db.getMutationReceipt(caller, 'release-restart')?.state).toBe('pending')
    first.db.close()
    openDbs.splice(openDbs.indexOf(first.db), 1)

    const restarted = createHarness(dbPath, 'exited', openDbs)
    const released = await restarted.dispatcher.dispatch({ ...request, id: 'rpc_release_2' })
    expect(released).toMatchObject({
      ok: true,
      result: {
        state: 'released',
        processAction: 'none',
        archive: { status: 'captured' },
        mutation: { requestId: 'release-restart', replayed: true }
      }
    })
    expect(restarted.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(restarted.db.getWorkerTerminalResourceByOwner(dispatchId)?.lifecycle_state).toBe(
      'released'
    )
    expect(restarted.db.getMutationReceipt(caller, 'release-restart')?.state).toBe('completed')
    const replay = await restarted.dispatcher.dispatch({ ...request, id: 'rpc_release_3' })
    expect(replay).toMatchObject({
      ok: true,
      result: { state: 'released', mutation: { replayed: true } }
    })
    expect(restarted.runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledTimes(1)
    restarted.db.close()
    openDbs.splice(openDbs.indexOf(restarted.db), 1)
  })

  it('coalesces concurrent exact-live retries into one close and one final receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-release-finality-'))
    tempPaths.push(dir)
    const harness = createHarness(join(dir, 'orchestration.db'), 'live', openDbs)
    const dispatchId = await createSettledWorker(harness)
    const request = releaseRequest(dispatchId)
    vi.mocked(harness.runtime.closeTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      tabId: 'tab_worker',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable'
    })
    await harness.dispatcher.dispatch(request)
    vi.mocked(harness.runtime.closeTerminal).mockClear()
    const closeGate = deferred()
    vi.mocked(harness.runtime.closeTerminal).mockImplementationOnce(async (handle) => {
      await closeGate.promise
      return { handle, tabId: 'tab_worker', ptyKilled: true }
    })

    const first = harness.dispatcher.dispatch({ ...request, id: 'rpc_retry_1' })
    await vi.waitFor(() => expect(harness.runtime.closeTerminal).toHaveBeenCalledOnce())
    const second = harness.dispatcher.dispatch({ ...request, id: 'rpc_retry_2' })
    closeGate.resolve()

    await expect(first).resolves.toMatchObject({
      ok: true,
      result: { state: 'released', mutation: { replayed: true } }
    })
    await expect(second).resolves.toMatchObject({
      ok: true,
      result: { state: 'released', mutation: { replayed: true } }
    })
    expect(harness.runtime.closeTerminal).toHaveBeenCalledOnce()
    const caller = harness.db.getOrCreateLocalMutationCallerFingerprint()
    expect(harness.db.getMutationReceipt(caller, 'release-restart')?.state).toBe('completed')
    harness.db.close()
    openDbs.splice(openDbs.indexOf(harness.db), 1)
  })

  it.each([
    { verdict: 'unverifiable' as const, authorityConflict: false },
    { verdict: 'live' as const, authorityConflict: true }
  ])('keeps $verdict conflict retries pending without process action', async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-release-finality-'))
    tempPaths.push(dir)
    const harness = createHarness(join(dir, 'orchestration.db'), scenario.verdict, openDbs)
    const dispatchId = await createSettledWorker(harness)
    const request = releaseRequest(dispatchId)
    vi.mocked(harness.runtime.closeTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      tabId: 'tab_worker',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable'
    })
    await harness.dispatcher.dispatch(request)
    vi.mocked(harness.runtime.closeTerminal).mockClear()
    if (scenario.authorityConflict) {
      vi.mocked(harness.runtime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    }

    await expect(
      harness.dispatcher.dispatch({ ...request, id: 'rpc_release_retry' })
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'release_unknown', processAction: 'none' }
    })
    expect(harness.runtime.closeTerminal).not.toHaveBeenCalled()
    const caller = harness.db.getOrCreateLocalMutationCallerFingerprint()
    expect(harness.db.getMutationReceipt(caller, 'release-restart')?.state).toBe('pending')
    harness.db.close()
    openDbs.splice(openDbs.indexOf(harness.db), 1)
  })

  it('keeps an unavailable close pending until the same request settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-release-finality-'))
    tempPaths.push(dir)
    const harness = createHarness(join(dir, 'orchestration.db'), 'live', openDbs)
    const dispatchId = await createSettledWorker(harness)
    const request = releaseRequest(dispatchId)
    vi.mocked(harness.runtime.closeTerminal).mockRejectedValueOnce(
      new Error('Multiplexer disposed')
    )

    await expect(harness.dispatcher.dispatch(request)).resolves.toMatchObject({
      ok: true,
      result: { state: 'release_pending', processAction: 'none' }
    })
    const caller = harness.db.getOrCreateLocalMutationCallerFingerprint()
    expect(harness.db.getMutationReceipt(caller, 'release-restart')?.state).toBe('pending')

    await expect(
      harness.dispatcher.dispatch({ ...request, id: 'rpc_release_retry' })
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'released', mutation: { replayed: true } }
    })
    expect(harness.db.getMutationReceipt(caller, 'release-restart')?.state).toBe('completed')
    harness.db.close()
    openDbs.splice(openDbs.indexOf(harness.db), 1)
  })
})

function createHarness(
  dbPath: string,
  liveness: 'live' | 'unverifiable' | 'exited',
  openDbs: OrchestrationDb[]
): { db: OrchestrationDb; runtime: OrcaRuntimeService; dispatcher: RpcDispatcher } {
  const db = new OrchestrationDb(dbPath)
  openDbs.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  let workerHandle = 'term_worker'
  vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue(liveness)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_coord' ? coordinatorPaneKey : handle === workerHandle ? workerPaneKey : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === workerHandle ? processIncarnation : null
  )
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
    handle === workerHandle
      ? ({
          terminalHandle: handle,
          paneKey: workerPaneKey,
          processIncarnation,
          hostScope
        } as never)
      : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
  )
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::worktree'
  } as never)
  vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_selector, options) => {
    workerHandle = options?.preAllocatedHandle ?? 'term_worker'
    return { handle: workerHandle, worktreeId: 'repo::worktree', title: 'worker' }
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: workerHandle,
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: workerHandle,
    accepted: true,
    bytesWritten: 1,
    semanticObservedAt: Date.now()
  })
  vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: workerHandle,
    status: 'running',
    tail: ['archived worker output'],
    truncated: false,
    nextCursor: '1'
  })
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle: workerHandle,
    tabId: 'tab_worker',
    ptyKilled: true
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return {
    db,
    runtime,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  }
}

async function createSettledWorker(harness: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
}): Promise<string> {
  const run = harness.db.createRun({
    objective: 'Release finality',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey
  })
  const task = harness.db.createTask({ spec: 'release finality', runId: run.id })
  const method = ORCHESTRATION_METHODS.find(
    (candidate) => candidate.name === 'orchestration.workerStart'
  )
  if (!method) {
    throw new Error('workerStart method missing')
  }
  const params = method.params?.parse({ task: task.id, from: 'term_coord', agent: 'codex' })
  const started = (await method.handler(params, {
    runtime: harness.runtime
  } as RpcContext)) as { dispatchId: string; state: string; error?: string }
  if (started.state !== 'ready') {
    throw new Error(`worker fixture failed: ${JSON.stringify(started)}`)
  }
  expect(
    harness.db.settleWorkerReport({
      taskId: task.id,
      dispatchId: started.dispatchId,
      outcome: 'succeeded',
      result: 'complete'
    })
  ).toMatchObject({ action: 'settled' })
  return started.dispatchId
}

function releaseRequest(dispatchId: string): RpcRequest {
  return {
    id: 'rpc_release_1',
    authToken: 'caller-token',
    method: 'orchestration.workerRelease',
    params: { dispatch: dispatchId },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: 'release-restart'
  }
}
