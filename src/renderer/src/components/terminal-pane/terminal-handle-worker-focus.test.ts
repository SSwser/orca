import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { focusTerminalHandleForWorktree } from './terminal-handle-links'

const mocks = vi.hoisted(() => ({
  state: {} as AppState,
  activateTabAndFocusPane: vi.fn(),
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

function baseState(overrides: Record<string, unknown> = {}): AppState {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    projectGroups: [],
    folderWorkspaces: [],
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    setActiveView: vi.fn(),
    setActiveTabType: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    setActiveTab: vi.fn(),
    ...overrides
  } as unknown as AppState
}

describe('focusTerminalHandleForWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mocks.state = baseState()
    vi.stubGlobal('window', {
      api: {
        runtime: { call: vi.fn().mockResolvedValue({ ok: true, result: { focus: {} } }) },
        runtimeEnvironments: { call: vi.fn() }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
  })

  it('focuses the exact hydrated pane for a folder workspace without an RPC', async () => {
    mocks.state = baseState({
      projectGroups: [{ id: 'group-local', connectionId: null, executionHostId: 'local' }],
      folderWorkspaces: [
        { id: 'folder-local', projectGroupId: 'group-local', executionHostId: 'local' }
      ],
      tabsByWorktree: {
        'folder:folder-local': [
          {
            id: 'tab-folder',
            worktreeId: 'folder:folder-local',
            ptyId: null,
            title: 'Worker',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'tab-folder': ['term-folder'] },
      terminalLayoutsByTabId: {
        'tab-folder': {
          root: { type: 'leaf', leafId: 'leaf-worker' },
          activeLeafId: 'leaf-worker',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-worker': 'term-folder' }
        }
      }
    })

    await expect(
      focusTerminalHandleForWorktree({
        handle: 'term-folder',
        worktreeId: 'folder:folder-local'
      })
    ).resolves.toBe('renderer')

    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-folder', 'leaf-worker')
    expect(window.api.runtime.call).not.toHaveBeenCalled()
  })

  it('routes a background Worker focus to its paired runtime owner', async () => {
    mocks.state = baseState({
      repos: [{ id: 'repo-remote', connectionId: null, executionHostId: 'runtime:env-owner' }],
      worktreesByRepo: {
        'repo-remote': [
          {
            id: 'repo-remote::worker',
            repoId: 'repo-remote',
            hostId: 'runtime:env-owner'
          }
        ]
      }
    })
    markRuntimeEnvironmentCompatible('env-owner')
    window.api.runtimeEnvironments.call = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { focus: {} } })

    await expect(
      focusTerminalHandleForWorktree({
        handle: 'term-remote',
        worktreeId: 'repo-remote::worker'
      })
    ).resolves.toBe('runtime')

    expect(window.api.runtime.call).not.toHaveBeenCalled()
    expect(window.api.runtimeEnvironments.call).toHaveBeenCalledWith({
      selector: 'env-owner',
      method: 'terminal.focus',
      params: { terminal: 'term-remote', navigation: 'host' },
      timeoutMs: undefined
    })
  })

  it('routes a background local Git Worker through the local runtime owner', async () => {
    mocks.state = baseState({
      repos: [{ id: 'repo-local', connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: {
        'repo-local': [{ id: 'repo-local::worker', repoId: 'repo-local', hostId: 'local' }]
      }
    })

    await expect(
      focusTerminalHandleForWorktree({
        handle: 'term-local',
        worktreeId: 'repo-local::worker'
      })
    ).resolves.toBe('runtime')

    expect(window.api.runtime.call).toHaveBeenCalledWith({
      method: 'terminal.focus',
      params: { terminal: 'term-local', navigation: 'host' }
    })
    expect(window.api.runtimeEnvironments.call).not.toHaveBeenCalled()
  })

  it('fails closed when a direct SSH owner cannot verify exact focus', async () => {
    mocks.state = baseState({
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-one', executionHostId: 'ssh:ssh-one' }],
      worktreesByRepo: {
        'repo-ssh': [{ id: 'repo-ssh::worker', repoId: 'repo-ssh', hostId: 'ssh:ssh-one' }]
      }
    })
    window.api.runtime.call = vi.fn().mockRejectedValue(new Error('ssh_unverifiable'))

    await expect(
      focusTerminalHandleForWorktree({
        handle: 'term-ssh',
        worktreeId: 'repo-ssh::worker'
      })
    ).rejects.toThrow('ssh_unverifiable')

    expect(window.api.runtime.call).toHaveBeenCalledTimes(1)
    expect(window.api.runtimeEnvironments.call).not.toHaveBeenCalled()
  })

  it('fails closed before any focus call when workspace ownership is unknown', async () => {
    await expect(
      focusTerminalHandleForWorktree({ handle: 'term-unknown', worktreeId: 'unknown::worker' })
    ).rejects.toThrow('terminal_focus_owner_unverifiable')

    expect(window.api.runtime.call).not.toHaveBeenCalled()
    expect(window.api.runtimeEnvironments.call).not.toHaveBeenCalled()
  })

  it('does not call terminal.focus when a mixed-version runtime fails compatibility', async () => {
    mocks.state = baseState({
      repos: [{ id: 'repo-old', connectionId: null, executionHostId: 'runtime:env-old' }],
      worktreesByRepo: {
        'repo-old': [{ id: 'repo-old::worker', repoId: 'repo-old', hostId: 'runtime:env-old' }]
      }
    })
    window.api.runtimeEnvironments.call = vi.fn().mockRejectedValue(new Error('protocol_mismatch'))

    await expect(
      focusTerminalHandleForWorktree({
        handle: 'term-old',
        worktreeId: 'repo-old::worker'
      })
    ).rejects.toThrow('protocol_mismatch')

    expect(window.api.runtimeEnvironments.call).toHaveBeenCalledTimes(1)
    expect(window.api.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-old', method: 'status.get' })
    )
  })
})
