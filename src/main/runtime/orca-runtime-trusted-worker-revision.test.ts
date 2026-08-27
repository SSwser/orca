import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { acquireWorkerGenerationEffect } from './rpc/methods/orchestration-worker-generation-effect'

describe('trusted worker recovery revision', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  async function createRuntime(kind: 'git' | 'folder' = 'git') {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-recovery-revision-'))
    const repoPath = join(root, 'repo')
    mkdirSync(repoPath)
    tempPaths.push(root)
    if (kind === 'git') {
      await gitExecFileAsync(['init'], { cwd: repoPath })
      await gitExecFileAsync(
        [
          '-c',
          'user.name=Orca Test',
          '-c',
          'user.email=orca-test@example.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'trusted revision'
        ],
        { cwd: repoPath }
      )
    }
    const repo = {
      id: 'repo',
      path: repoPath,
      displayName: 'recovery revision',
      badgeColor: '#000000',
      addedAt: 1,
      kind
    }
    const metaById = new Map<string, Record<string, unknown>>()
    const store = {
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getSettings: () => ({ workspaceDir: join(root, 'workspaces') }),
      getProjects: () => [],
      getProjectHostSetups: () => [],
      getAllWorktreeMeta: () => Object.fromEntries(metaById),
      getWorktreeMeta: (id: string) => metaById.get(id),
      setWorktreeMeta: (id: string, updates: Record<string, unknown>) => {
        const next = { ...metaById.get(id), ...updates }
        metaById.set(id, next)
        return next
      }
    }
    return { runtime: new OrcaRuntimeService(store as never), repoPath }
  }

  it('accepts only the exact immutable commit present in the local Git provider', async () => {
    const { runtime, repoPath } = await createRuntime()
    const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: repoPath })
    const revision = stdout.trim()

    await expect(runtime.resolveLocalManagedRepoCommit('repo', revision)).resolves.toBe(revision)
    await expect(runtime.resolveLocalManagedRepoCommit('repo', 'f'.repeat(40))).rejects.toThrow()
    await expect(runtime.resolveLocalManagedRepoCommit('repo', 'main')).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('fails closed for a folder provider without isolated Git generations', async () => {
    const { runtime } = await createRuntime('folder')

    await expect(
      runtime.resolveLocalManagedRepoCommit('repo', '0'.repeat(40))
    ).rejects.toMatchObject({ code: 'federation_unsupported' })
  })

  it('reads back only the exact managed-worktree operation receipt', async () => {
    const { runtime } = await createRuntime()
    const operation = {
      operationId: 'worker-generation-operation',
      payloadFingerprint: 'worker-generation-payload',
      branchName: 'orca-worker/exact-generation'
    }
    const worktree = {
      id: 'repo::generation-2',
      repoId: 'repo',
      branch: 'refs/heads/orca-worker/exact-generation',
      workerGenerationOperation: {
        operationId: operation.operationId,
        payloadFingerprint: operation.payloadFingerprint,
        completedReceipt: {
          worktreeId: 'repo::generation-2',
          terminalHandle: 'term_generation_2',
          setup: {
            requested: 'run',
            hookFound: false,
            startupPolicy: 'start-immediately',
            state: 'not_configured'
          }
        }
      }
    }
    const runtimeWithList = runtime as unknown as {
      listResolvedWorktrees: () => Promise<(typeof worktree)[]>
    }
    const list = vi.spyOn(runtimeWithList, 'listResolvedWorktrees').mockResolvedValue([worktree])

    await expect(
      runtime.inspectManagedWorkerGenerationOperation({ repoSelector: 'repo', ...operation })
    ).resolves.toMatchObject({
      verdict: 'completed',
      worktree: { id: 'repo::generation-2' },
      receipt: { terminalHandle: 'term_generation_2' }
    })
    worktree.workerGenerationOperation.payloadFingerprint = 'changed'
    await expect(
      runtime.inspectManagedWorkerGenerationOperation({ repoSelector: 'repo', ...operation })
    ).resolves.toEqual({ verdict: 'conflict' })
    list.mockResolvedValue([])
    await expect(
      runtime.inspectManagedWorkerGenerationOperation({ repoSelector: 'repo', ...operation })
    ).resolves.toEqual({ verdict: 'not_started' })
  })

  it('fails closed on a real residual worktree whose exact operation receipt is incomplete', async () => {
    const { runtime, repoPath } = await createRuntime()
    const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: repoPath })
    const operation = {
      operationId: 'worker-generation-residual',
      payloadFingerprint: 'worker-generation-residual-payload',
      branchName: 'orca-worker/residual-generation'
    }
    const created = await runtime.createManagedWorktree({
      repoSelector: 'repo',
      name: 'residual-generation',
      baseBranch: stdout.trim(),
      branchNameOverride: operation.branchName,
      workerGenerationOperation: operation
    })
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'resume exact residual generation' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { operation }
      })
      db.claimWorkerGenerationOperation({
        dispatchId: started.dispatch.id,
        effectKind: 'worktree',
        ...operation,
        claimantId: 'prior-runtime:worktree'
      })
      const create = vi.spyOn(runtime, 'createManagedWorktree')

      await expect(
        acquireWorkerGenerationEffect({
          db,
          dispatchId: started.dispatch.id,
          effectKind: 'worktree',
          identity: operation,
          runtimeEpoch: 'restarted-runtime',
          claimantId: 'restarted-runtime:worktree',
          inspect: async () =>
            await runtime.inspectManagedWorkerGenerationOperation({
              repoSelector: 'repo',
              ...operation
            })
        })
      ).resolves.toEqual({ disposition: 'in_progress' })
      expect(create).not.toHaveBeenCalled()
      expect(
        (
          await gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repoPath })
        ).stdout.match(/^worktree /gm)
      ).toHaveLength(2)
      expect(created.worktree.branch).toBe(`refs/heads/${operation.branchName}`)
    } finally {
      db.close()
    }
  })
})
