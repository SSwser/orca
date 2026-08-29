import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('worker generation operation claims', () => {
  let first: OrchestrationDb | undefined
  let second: OrchestrationDb | undefined
  let root: string | undefined

  afterEach(() => {
    second?.close()
    first?.close()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
    second = undefined
    first = undefined
    root = undefined
  })

  it('allows one claimant and exposes one exact completed receipt across connections', () => {
    root = mkdtempSync(join(tmpdir(), 'orca-worker-generation-operation-'))
    const path = join(root, 'orchestration.db')
    first = new OrchestrationDb(path)
    second = new OrchestrationDb(path)
    const operation = {
      dispatchId: 'ctx_successor',
      effectKind: 'worktree' as const,
      operationId: 'worker-operation-1',
      payloadFingerprint: 'payload-1'
    }

    expect(first.readWorkerGenerationOperation(operation)).toEqual({ verdict: 'not_started' })
    expect(
      first.claimWorkerGenerationOperation({ ...operation, claimantId: 'claimant-a' })
    ).toEqual({ claimed: true })
    expect(
      second.claimWorkerGenerationOperation({ ...operation, claimantId: 'claimant-b' })
    ).toEqual({
      claimed: false,
      verdict: 'unverifiable',
      claimantId: 'claimant-a',
      state: 'claimed'
    })
    expect(second.readWorkerGenerationOperation(operation)).toEqual({
      verdict: 'unverifiable'
    })
    expect(
      first.markWorkerGenerationOperationUnverifiable({ ...operation, claimantId: 'claimant-a' })
    ).toBe(true)
    expect(
      second.claimWorkerGenerationOperation({ ...operation, claimantId: 'claimant-b' })
    ).toEqual({
      claimed: false,
      verdict: 'unverifiable',
      claimantId: 'claimant-a',
      state: 'unverifiable'
    })
    expect(
      second.reclaimWorkerGenerationOperation({
        ...operation,
        expectedClaimantId: 'stale-claimant',
        claimantId: 'claimant-b'
      })
    ).toBe(false)
    expect(
      second.reclaimWorkerGenerationOperation({
        ...operation,
        expectedClaimantId: 'claimant-a',
        claimantId: 'claimant-b'
      })
    ).toBe(true)

    second.completeWorkerGenerationOperation({
      ...operation,
      claimantId: 'claimant-b',
      receipt: { worktreeId: 'repo::generation-2', instanceId: 'instance-2' }
    })
    expect(second.readWorkerGenerationOperation(operation)).toEqual({
      verdict: 'completed',
      receipt: { worktreeId: 'repo::generation-2', instanceId: 'instance-2' }
    })
    expect(
      second.readWorkerGenerationOperation({ ...operation, payloadFingerprint: 'changed' })
    ).toEqual({ verdict: 'conflict' })
  })

  it('keeps the provisional capability unusable until exact execution acceptance commits', () => {
    first = new OrchestrationDb(':memory:')
    const run = first.createRun({
      objective: 'atomic execution start',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:coord'
    })
    const task = first.createTask({ runId: run.id, spec: 'execute once' })
    const started = first.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const capability = first.reserveStartingWorkerCapability(started.dispatch.id)
    expect(first.reserveStartingWorkerCapability(started.dispatch.id)).toBe(capability)
    expect(
      first.verifyDispatchCapability({
        dispatchId: started.dispatch.id,
        capability,
        paneKey: 'tab:leaf',
        processIncarnation: 'daemon:pty:incarnation'
      })
    ).toMatchObject({ valid: false })

    const operation = {
      dispatchId: started.dispatch.id,
      effectKind: 'execution_start' as const,
      operationId: 'a'.repeat(43),
      payloadFingerprint: 'b'.repeat(64),
      claimantId: 'runtime:claimant'
    }
    const receipt = {
      operationId: operation.operationId,
      payloadFingerprint: operation.payloadFingerprint,
      semanticObservedAt: 123
    }
    expect(first.claimWorkerGenerationOperation(operation)).toEqual({ claimed: true })
    first.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab:leaf',
      processIncarnation: 'daemon:pty:incarnation',
      worktreeId: 'repo::worktree',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created',
      capability,
      generationOperation: { ...operation, receipt }
    })

    expect(first.getWorkerDispatch(started.dispatch.id)?.provisional_capability).toBeNull()
    expect(first.readWorkerGenerationOperation(operation)).toEqual({
      verdict: 'completed',
      receipt
    })
    expect(first.getWorkerTerminalResourceByOwner(started.dispatch.id)).toMatchObject({
      terminal_handle: 'term_worker',
      lifecycle_state: 'owned'
    })
    expect(
      first.verifyDispatchCapability({
        dispatchId: started.dispatch.id,
        capability,
        paneKey: 'tab:leaf',
        processIncarnation: 'daemon:pty:incarnation'
      })
    ).toEqual({ valid: true })
  })
})
