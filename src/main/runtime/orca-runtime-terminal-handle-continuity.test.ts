import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

const REPO_ID = 'repo-handle-continuity'
const WORKTREE_PATH = '/tmp/terminal-handle-continuity'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const TAB_ID = 'tab-handle-continuity'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-handle-continuity'
const INCARNATION_ID = '22222222-2222-4222-8222-222222222222'
const EXECUTION_OPERATION = {
  operationId: 'a'.repeat(43),
  payloadFingerprint: 'b'.repeat(64)
}
const EXECUTION_HANDLE = 'term_execution-operation'
const testDbs: OrchestrationDb[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const db of testDbs.splice(0)) {
    db.close()
  }
})

function createHarness(options: { executionOperation?: boolean } = {}) {
  let incarnationId = INCARNATION_ID
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: INCARNATION_ID
    }
  }
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'handle-continuity',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: () => {}
  }
  const runtime = new OrcaRuntimeService(store as never)
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  testDbs.push(db)
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => true),
    stopAndWait: vi.fn(async () => false),
    listProcesses: vi.fn(async () => [
      {
        id: PTY_ID,
        incarnationId,
        cwd: WORKTREE_PATH,
        title: 'Fixture shell',
        ...(options.executionOperation
          ? {
              terminalHandle: EXECUTION_HANDLE,
              agentSessionCreateOperation: EXECUTION_OPERATION
            }
          : {})
      }
    ]),
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)

  const syncFixtureGraph = () =>
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 7,
          ptyId: PTY_ID
        }
      ]
    })
  syncFixtureGraph()
  return {
    runtime,
    syncFixtureGraph,
    syncEmptyGraph: () => runtime.syncWindowGraph(1, { tabs: [], leaves: [] }),
    replaceIncarnation: (next: string) => {
      incarnationId = next
    }
  }
}

describe('terminal handle incarnation continuity', () => {
  it('restores the exact execution operation with its controller-owned terminal handle', async () => {
    const harness = createHarness({ executionOperation: true })
    ;(
      harness.runtime as unknown as {
        resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
      }
    ).resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      id: WORKTREE_ID,
      path: WORKTREE_PATH,
      connectionId: null
    }))
    vi.spyOn(harness.runtime, 'getExactWorkerProviderSession').mockReturnValue({
      paneKey: makePaneKey(TAB_ID, LEAF_ID),
      processIncarnation: `${PTY_ID}:${INCARNATION_ID}`,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'codex-session' },
      observedAt: Date.now()
    })

    await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(
      (
        harness.runtime as unknown as {
          ptysById: Map<string, { agentSessionCreateOperation: unknown }>
        }
      ).ptysById.get(PTY_ID)?.agentSessionCreateOperation
    ).toEqual(EXECUTION_OPERATION)
    expect(harness.runtime.getOrchestrationDispatchAuthority(EXECUTION_HANDLE)).toMatchObject({
      ptyId: PTY_ID,
      paneKey: makePaneKey(TAB_ID, LEAF_ID),
      processIncarnation: `${PTY_ID}:${INCARNATION_ID}`
    })
    await expect(harness.runtime.showTerminal(EXECUTION_HANDLE)).resolves.toMatchObject({
      handle: EXECUTION_HANDLE,
      worktreeId: WORKTREE_ID
    })
    await expect(
      harness.runtime.inspectAgentSessionExecutionStart(`id:${WORKTREE_ID}`, {
        ...EXECUTION_OPERATION,
        targetFingerprint: 'c'.repeat(64),
        terminalHandle: EXECUTION_HANDLE,
        launchToken: 'launch-token',
        writeFence: { ownerId: 'ctx_worker', generation: EXECUTION_OPERATION.operationId },
        semanticBaselineAt: Date.now() - 1_000,
        timeoutMs: 1_000
      })
    ).resolves.toMatchObject({
      verdict: 'accepted',
      receipt: { terminalHandle: EXECUTION_HANDLE }
    })
  })

  it('keeps a handle valid when renderer reload preserves the PTY incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after).toMatchObject({ handle: before.handle, incarnationId: INCARNATION_ID })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('keeps a handle through an intermediate empty reload graph', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(before.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    harness.runtime.markRendererReloading(1)
    harness.syncEmptyGraph()
    harness.syncFixtureGraph()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
    await expect(waiting).resolves.toMatchObject({
      handle: before.handle,
      condition: 'tui-idle',
      satisfied: true
    })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('resolves a retained handle waiter when idle arrives during renderer reload', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(before.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    harness.runtime.markRendererReloading(1)
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u2733 Task complete\x07done\n', 200)

    await expect(waiting).resolves.toMatchObject({
      handle: before.handle,
      condition: 'tui-idle',
      satisfied: true
    })
    harness.syncFixtureGraph()
    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
  })

  it('stales the old handle when the same PTY id names a new incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.replaceIncarnation('33333333-3333-4333-8333-333333333333')
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    expect(after.incarnationId).toBe('33333333-3333-4333-8333-333333333333')
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('stales a retained handle after the renderer graph becomes unavailable', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markGraphUnavailable(1)
    harness.runtime.attachWindow(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('stales a renderer handle superseded by a preallocated handle', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    const preallocated = 'term_preallocated-close-continuity'

    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, preallocated)
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
    await expect(harness.runtime.readTerminal(preallocated)).resolves.toMatchObject({
      handle: preallocated,
      status: 'running'
    })
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(preallocated)
    await expect(harness.runtime.readTerminal(preallocated)).resolves.toMatchObject({
      handle: preallocated,
      status: 'running'
    })
  })

  it('keeps a renderer handle when the controller adopts that same handle', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, before.handle)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('rejects a preallocated-handle waiter when its PTY is invalidated during reload', async () => {
    const harness = createHarness()
    const preallocated = 'term_preallocated-reload-invalidation'
    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, preallocated)
    harness.syncFixtureGraph()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(preallocated, {
      condition: 'tui-idle',
      timeoutMs: 100
    })

    harness.runtime.markRendererReloading(1)
    harness.runtime['invalidateAllHandlesForPty'](PTY_ID)

    await expect(waiting).rejects.toThrow('terminal_handle_stale')
  })
})
