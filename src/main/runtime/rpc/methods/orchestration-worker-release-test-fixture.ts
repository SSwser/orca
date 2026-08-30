import { expect, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'

export const workerReleaseLocalHostScope = {
  kind: 'local' as const,
  hostId: 'local' as const,
  restartCustody: {
    kind: 'windows_daemon_job' as const,
    daemonPid: 4000,
    daemonStartedAtMs: 1_786_000_000_000,
    daemonLaunchNonce: 'release-test-daemon'
  }
}

export const workerReleaseCoordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const workerReleasePaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

export class WorkerReleaseTestFixture {
  readonly db = new OrchestrationDb(':memory:')
  readonly runtime = new OrcaRuntimeService()
  readonly ctx: RpcContext = { runtime: this.runtime }
  readonly inspectProcessLiveness = vi.fn().mockResolvedValue('live')
  readonly activeRunId: string
  workerHandle = 'term_worker'

  constructor() {
    this.runtime.setOrchestrationDb(this.db)
    ;(
      this.runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: ReturnType<typeof vi.fn>
      }
    ).inspectTerminalProcessIncarnationLiveness = this.inspectProcessLiveness
    vi.spyOn(this.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? workerReleaseCoordinatorPaneKey
        : this.isWorkerHandle(handle)
          ? workerReleasePaneKey
          : null
    )
    vi.spyOn(this.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      this.isWorkerHandle(handle) ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(this.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_coord'
        ? ({
            terminalHandle: handle,
            paneKey: workerReleaseCoordinatorPaneKey,
            processIncarnation: 'runtime_test:term_coord:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : this.isWorkerHandle(handle)
          ? ({
              terminalHandle: handle,
              paneKey: workerReleasePaneKey,
              processIncarnation: 'runtime_test:term_worker:1',
              hostScope: workerReleaseLocalHostScope
            } as never)
          : null
    )
    vi.spyOn(this.runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(this.runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(this.runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
    vi.spyOn(this.runtime, 'createTerminal').mockImplementation(async (_selector, options) => {
      this.workerHandle = options?.preAllocatedHandle ?? 'term_worker'
      return { handle: this.workerHandle, worktreeId: 'repo::worktree', title: 'worker' }
    })
    vi.spyOn(this.runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(this.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(this.runtime, 'resolveWorkerAgentProcessAdmission').mockReturnValue({
      targetFingerprint: 'c'.repeat(64)
    })
    vi.spyOn(this.runtime, 'createAgentSession').mockImplementation(async (request) => {
      const start = request.executionStart!
      this.workerHandle = start.terminalHandle
      return {
        terminal: {
          handle: this.workerHandle,
          worktreeId: 'repo::worktree',
          title: 'Codex',
          surface: 'background'
        },
        disposition: 'created',
        executionStartReceipt: {
          ...start,
          launchTokenHash: 'test-launch-token-hash',
          paneKey: workerReleasePaneKey,
          processIncarnation: 'runtime_test:term_worker:1',
          hostScope: workerReleaseLocalHostScope,
          providerSession: { key: 'session_id', id: 'codex-release-worker' },
          turnStartedAt: Date.now(),
          semanticObservedAt: Date.now()
        }
      }
    })
    vi.spyOn(this.runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(this.runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(this.runtime, 'readTerminal').mockImplementation(async (handle) => ({
      handle,
      status: 'running',
      tail: ['worker output line 1', 'worker output line 2'],
      truncated: false,
      nextCursor: '2'
    }))
    vi.spyOn(this.runtime, 'closeTerminal').mockImplementation(async (handle) => ({
      handle,
      tabId: 'tab-worker',
      ptyKilled: true
    }))
    vi.spyOn(this.runtime, 'notifyWorkerTerminalReleased').mockImplementation(() => {})
    vi.spyOn(this.runtime, 'notifyMessageArrived').mockImplementation(() => {})
    this.activeRunId = this.db.createRun({
      objective: 'Release test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: workerReleaseCoordinatorPaneKey
    }).id
  }

  close(): void {
    this.db.close()
  }

  async call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, this.ctx)
  }

  async startWorker(): Promise<{ taskId: string; dispatchId: string }> {
    const task = this.db.createTask({ spec: 'release fixture task', runId: this.activeRunId })
    const result = (await this.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  settle(taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed'): void {
    const settlement = this.db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome,
      result: `worker ${outcome}`
    })
    expect(settlement.action).toBe('settled')
  }

  async startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await this.startWorker()
    this.settle(worker.taskId, worker.dispatchId, outcome)
    return worker
  }

  private isWorkerHandle(handle: string): boolean {
    return [this.workerHandle, 'term_worker', 'term_reminted'].includes(handle)
  }
}
