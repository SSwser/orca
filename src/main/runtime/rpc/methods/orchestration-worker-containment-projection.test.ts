import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from './orchestration-worker-control'
import { ORCHESTRATION_WORKER_RELEASE_METHODS } from './orchestration-worker-release'
import { exposeWorkerTerminalContainment } from './orchestration-worker-release-completion'

type Containment = Parameters<typeof exposeWorkerTerminalContainment>[0]

function containment(disposition: 'accept_archived_result' | 'retry_with_successor'): Containment {
  return {
    recovery: {
      id: 'recovery-1',
      disposition,
      source_delivery_id: 'delivery-1',
      source_worktree_id: 'worktree-1',
      trusted_revision: disposition === 'retry_with_successor' ? 'a'.repeat(40) : null,
      successor_dispatch_id: disposition === 'retry_with_successor' ? 'dispatch-2' : null,
      successor_worktree_id: disposition === 'retry_with_successor' ? 'worktree-2' : null,
      successor_placement: disposition === 'retry_with_successor' ? 'new-child' : null
    },
    capacityState: 'released',
    capacityReleasedAt: '2026-08-28 00:00:00'
  } as Containment
}

function method(name: string) {
  const candidate = [
    ...ORCHESTRATION_WORKER_CONTROL_METHODS,
    ...ORCHESTRATION_WORKER_RELEASE_METHODS
  ].find((entry) => entry.name === name)
  if (!candidate) {
    throw new Error(`Missing ${name}`)
  }
  return candidate
}

function runtimeFor(disposition: 'accept_archived_result' | 'retry_with_successor') {
  const resource = {
    id: 'resource-1',
    lifecycle_state: 'contained',
    retained_reason: 'lost_custody',
    terminal_handle: 'term-1',
    worktree_id: 'worktree-1',
    origin_dispatch_id: 'dispatch-1',
    owner_dispatch_id: 'dispatch-1',
    release_requested_at: null,
    release_completed_at: null,
    release_error: null,
    archive_source: 'terminal_tail',
    archive_status: 'captured'
  }
  const dispatch = { id: 'dispatch-1', run_id: 'run-1' }
  const worker = {
    dispatch_id: 'dispatch-1',
    runtime_epoch: 'runtime-1',
    state: 'failed',
    stage: 'process_exited',
    agent_terminal_handle: 'term-1',
    effects: '[]',
    residual_resources: '[]',
    start_options: '{}'
  }
  const db = {
    getDispatchContextById: () => dispatch,
    getWorkerDispatch: () => worker,
    getFederatedDispatch: () => null,
    isDispatchProcessCurrent: () => true,
    getWorkerTerminalResourceByOwner: () => resource,
    getWorkerTerminalContainment: () => containment(disposition),
    listWorkerTerminalResources: () => [
      {
        dispatchId: 'dispatch-1',
        taskId: 'task-1',
        runId: 'run-1',
        workerState: 'failed',
        dispatchStatus: 'failed',
        agentTerminalHandle: 'term-1',
        terminalState: 'contained',
        resource
      }
    ]
  }
  return {
    getOrchestrationDb: () => db,
    getRuntimeId: () => 'runtime-1',
    showTerminal: async () => ({ handle: 'term-1', connected: false }),
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'runtime-1:pty-1:1',
    getTerminalLivenessVerdict: () => ({ status: 'exited' })
  } as never
}

describe('worker containment projection', () => {
  it.each(['accept_archived_result', 'retry_with_successor'] as const)(
    'preserves the immutable %s disposition through show and list',
    async (disposition) => {
      expect(exposeWorkerTerminalContainment(containment(disposition))).toMatchObject({
        disposition
      })
      const runtime = runtimeFor(disposition)
      const show = method('orchestration.workerShow')
      await expect(
        show.handler(show.params!.parse({ dispatch: 'dispatch-1' }), { runtime })
      ).resolves.toMatchObject({ containment: { disposition } })
      const list = method('orchestration.workerList')
      expect(list.handler(list.params!.parse({}), { runtime })).toMatchObject({
        workers: [
          expect.objectContaining({
            containment: expect.objectContaining({ disposition })
          })
        ]
      })
    }
  )
})
