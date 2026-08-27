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
})
