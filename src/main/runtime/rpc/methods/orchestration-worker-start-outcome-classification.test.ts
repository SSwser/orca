import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import {
  isUnknownWorkerStartOutcome,
  requireWorkerAuthority
} from './orchestration-worker-topology'

describe('worker start outcome classification', () => {
  it('treats an explicit operation_unknown code as unknown at any stage', () => {
    const error = Object.assign(new Error('relay dropped'), { code: 'operation_unknown' })

    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(true)
    expect(isUnknownWorkerStartOutcome(error, 'worktree_create')).toBe(true)
  })

  it('treats a lost connection during worktree create as unknown', () => {
    expect(isUnknownWorkerStartOutcome(new Error('connection reset'), 'worktree_create')).toBe(true)
    expect(isUnknownWorkerStartOutcome(new Error('request timed out'), 'worktree_create')).toBe(
      true
    )
  })

  it('keeps a definite failure definite', () => {
    expect(isUnknownWorkerStartOutcome(new Error('connection reset'), 'dispatch_input')).toBe(false)
    expect(isUnknownWorkerStartOutcome(new Error('worktree exists'), 'worktree_create')).toBe(false)
  })

  it('rejects otherwise exact local authority without restart custody', () => {
    const runtime = {
      getOrchestrationDispatchAuthority: () => ({
        terminalHandle: 'term-worker',
        paneKey: 'tab-worker:leaf-worker',
        processIncarnation: 'runtime:pty:incarnation',
        hostScope: { kind: 'local', hostId: 'local' }
      }),
      getTerminalPaneKey: () => 'tab-worker:leaf-worker',
      getTerminalProcessIncarnation: () => 'runtime:pty:incarnation'
    }

    expect(() =>
      requireWorkerAuthority(runtime as never, 'term-worker', {
        requireNativeWindowsRestartCustody: true
      })
    ).toThrow('terminal_restart_custody_unavailable')
  })

  it('settles a definite reconciliation failure from start_unknown', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'reconcile worker start',
        coordinatorHandle: 'term-coordinator',
        coordinatorPaneKey: 'tab-coordinator:leaf-coordinator'
      })
      const task = db.createTask({ spec: 'settle known failure', runId: run.id })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })
      db.markWorkerStartUnknown(started.dispatch.id, 'terminal_creating', 'outcome unknown')

      expect(
        failWorkerStartWithReceipt({
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage: 'agent_readiness',
          error: new Error('terminal_restart_custody_unavailable'),
          setup: {} as never,
          launch: {} as never
        })
      ).toMatchObject({ state: 'failed', lastError: 'terminal_restart_custody_unavailable' })
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('failed')
    } finally {
      db.close()
    }
  })
})
