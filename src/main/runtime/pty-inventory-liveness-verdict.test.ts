import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { SSH_EXIT_UNCONFIRMED_REASON } from '../../shared/pty-liveness-verdict'

// The aggregate inventory only enumerates registered providers, so a dropped
// relay clears `connected` for every one of its PTYs at once. Only the
// provider's own answer separates an observed exit from lost contact.

const WORKTREE_ID = 'repo-1::/tmp/inventory-verdict'
const REMOTE_PTY_ID = 'ssh:conn-1@@relay-9'
const LOCAL_PTY_ID = `${WORKTREE_ID}@@local-1`
const RESTART_CUSTODY = {
  kind: 'windows_daemon_job' as const,
  daemonPid: 4000,
  daemonStartedAtMs: 1_786_000_000_000,
  daemonLaunchNonce: 'inventory-verdict-daemon'
}
const testDbs: OrchestrationDb[] = []

afterEach(() => {
  for (const db of testDbs.splice(0)) {
    db.close()
  }
})

function createRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  testDbs.push(db)
  return runtime
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function makeStore() {
  const session = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/inventory-verdict',
        displayName: 'inventory-verdict',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntimeMissingFromInventory(
  hasPty: () => boolean | null,
  listProcesses: () => Promise<{ id: string; worktreeId: string }[]> = vi.fn(async () => []),
  kill: () => boolean = vi.fn(() => true)
): OrcaRuntimeService {
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill,
    hasPty,
    listProcesses,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  runtime.registerPty(REMOTE_PTY_ID, WORKTREE_ID, 'conn-1')
  return runtime
}

describe('inventory sweep liveness verdicts', () => {
  it('records an abnormal SSH exit as unverifiable at the runtime boundary', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)

    runtime.onPtyExit(REMOTE_PTY_ID, -1)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: SSH_EXIT_UNCONFIRMED_REASON
    })
  })

  it('preserves a more specific lost-contact reason across an abnormal SSH exit', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'inventory transport failed')

    runtime.onPtyExit(REMOTE_PTY_ID, -1)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'inventory transport failed'
    })
  })

  it('accepts a current owning-host exit even when its numeric code is negative', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'inventory transport failed')

    runtime.onPtyExit(REMOTE_PTY_ID, -1, undefined, { hostExitConfirmed: true })

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('records lost contact when no provider can answer for the PTY', async () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)

    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'no registered provider can observe its host'
    })
  })

  it('keeps a transport-connected orphan visible but non-actionable after lost contact', async () => {
    const inventory = deferred<{ id: string; worktreeId: string }[]>()
    const listProcesses = vi.fn(() => inventory.promise)
    const kill = vi.fn(() => true)
    const runtime = makeRuntimeMissingFromInventory(() => null, listProcesses, kill)
    const listing = runtime.listTerminals(`id:${WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'stop outcome was not verified')
    inventory.resolve([{ id: REMOTE_PTY_ID, worktreeId: WORKTREE_ID }])

    const [listed] = (await listing).terminals

    expect(listed).toMatchObject({ connected: true, writable: false, orphaned: true })
    await expect(runtime.showTerminal(listed!.handle)).resolves.toMatchObject({
      connected: true,
      writable: false,
      orphaned: true
    })
    expect(runtime.getOrchestrationDispatchAuthority(listed!.handle)).toBeNull()
    await expect(runtime.sendTerminal(listed!.handle, { text: 'unsafe' })).rejects.toThrow(
      'terminal_not_writable'
    )
    await expect(runtime.sendTerminalAgentPrompt(listed!.handle, 'unsafe')).rejects.toThrow(
      'terminal_not_writable'
    )
    await expect(runtime.splitTerminal(listed!.handle)).rejects.toThrow('terminal_exited')
    await expect(runtime.closeTerminal(listed!.handle)).resolves.toMatchObject({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable'
    })
    expect(kill).not.toHaveBeenCalled()
  })

  it('records no doubt when the owning provider reports the PTY absent', async () => {
    const runtime = makeRuntimeMissingFromInventory(() => false)

    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    // An observed absence is the death certificate callers already act on.
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('clears lost-contact doubt when reconnect inventory observes the PTY live', async () => {
    let reconnected = false
    const runtime = makeRuntimeMissingFromInventory(
      () => null,
      vi.fn(async () => (reconnected ? [{ id: REMOTE_PTY_ID, worktreeId: WORKTREE_ID }] : []))
    )

    await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)?.status).toBe('unverifiable')

    reconnected = true
    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('clears stale restart custody when authoritative inventory omits it', async () => {
    let includesCustody = true
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      hasPty: () => true,
      listProcesses: async () => [
        {
          id: LOCAL_PTY_ID,
          worktreeId: WORKTREE_ID,
          incarnationId: 'incarnation-1',
          cwd: '/tmp/inventory-verdict',
          title: 'shell',
          ...(includesCustody ? { restartCustody: RESTART_CUSTODY } : {})
        }
      ],
      getForegroundProcess: async () => null
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(LOCAL_PTY_ID, WORKTREE_ID, null, {
      tabId: 'tab-local',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: 'incarnation-1'
    } as never)

    const [terminal] = (await runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(runtime.getOrchestrationDispatchAuthority(terminal!.handle)?.hostScope).toEqual({
      kind: 'local',
      hostId: 'local',
      restartCustody: RESTART_CUSTODY
    })

    includesCustody = false
    await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(runtime.getOrchestrationDispatchAuthority(terminal!.handle)?.hostScope).toEqual({
      kind: 'local',
      hostId: 'local'
    })
  })

  it('does not let a pre-drop inventory clear a newer lost-contact verdict', async () => {
    const inventory = deferred<{ id: string; worktreeId: string }[]>()
    const listProcesses = vi.fn(() => inventory.promise)
    const runtime = makeRuntimeMissingFromInventory(() => null, listProcesses)

    const listing = runtime.listTerminals(`id:${WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'relay disconnected during stop')
    inventory.resolve([{ id: REMOTE_PTY_ID, worktreeId: WORKTREE_ID }])
    await listing

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'relay disconnected during stop'
    })
  })

  it('does not let a partial inventory overwrite a concurrent provider failure', async () => {
    const inventory = deferred<{ id: string; worktreeId: string }[]>()
    const listProcesses = vi.fn(() => inventory.promise)
    const runtime = makeRuntimeMissingFromInventory(() => false, listProcesses)

    const listing = runtime.listTerminals(`id:${WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'inventory transport failed')
    inventory.resolve([])
    await listing

    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
      status: 'unverifiable',
      reason: 'inventory transport failed'
    })
  })

  it('clears stale doubt when a new PTY lifecycle is positively registered', () => {
    const runtime = makeRuntimeMissingFromInventory(() => null)
    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'old incarnation lost contact')

    runtime.onPtySpawned(REMOTE_PTY_ID, 'incarnation-2')
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()

    runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'registration raced reconnect')
    runtime.registerPty(REMOTE_PTY_ID, WORKTREE_ID, 'conn-1', {
      tabId: 'tab-new',
      leafId: '00000000-0000-4000-8000-000000000001',
      incarnationId: 'incarnation-2'
    })
    expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toBeNull()
  })

  it('retains unresolved verdicts for every still-addressable PTY', () => {
    const runtime = createRuntime()
    for (let index = 0; index < 257; index += 1) {
      const ptyId = `ssh:conn-1@@relay-${index}`
      runtime.registerPty(ptyId, WORKTREE_ID, 'conn-1')
      runtime.markPtyLivenessUnverifiable(ptyId, 'provider disconnected')
    }

    expect(runtime.getPtyLivenessVerdict('ssh:conn-1@@relay-0')).toEqual({
      status: 'unverifiable',
      reason: 'provider disconnected'
    })
  })
})
