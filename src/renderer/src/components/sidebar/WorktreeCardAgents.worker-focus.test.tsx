import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  agents: [] as Record<string, unknown>[],
  displayMode: 'full' as 'compact' | 'full',
  capturedActivations: [] as ((tabId: string, paneKey: string) => void)[],
  activateAndRevealWorktree: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  focusTerminalHandleForWorktree: vi.fn(),
  addTerminalTab: vi.fn(),
  state: {
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    agentStatusByPaneKey: {} as Record<string, { worktreeId?: string }>
  }
}))

function storeState() {
  return {
    agentActivityDisplayMode: mocks.displayMode,
    acknowledgedAgentsByPaneKey: {},
    cacheTimerByKey: {},
    dropAgentStatus: vi.fn(),
    dismissRetainedAgent: vi.fn(),
    agentSendPopoverTargetMode: null,
    agentStatusEpoch: 0,
    agentStatusByPaneKey: mocks.state.agentStatusByPaneKey,
    retainedAgentsByPaneKey: {},
    tabsByWorktree: mocks.state.tabsByWorktree,
    terminalLayoutsByTabId: {},
    sendPromptToSidebarAgentTarget: vi.fn(),
    addTerminalTab: mocks.addTerminalTab,
    settings: { promptCacheTimerEnabled: false, promptCacheTtlMs: 60_000 }
  }
}

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: ReturnType<typeof storeState>) => unknown) => selector(storeState()),
    { getState: storeState }
  )
  return { useAppStore }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

vi.mock('../terminal-pane/terminal-handle-links', () => ({
  focusTerminalHandleForWorktree: mocks.focusTerminalHandleForWorktree
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: () => mocks.agents
}))

vi.mock('@/components/dashboard/useNow', () => ({ useNow: () => 2_000 }))
vi.mock('./focused-agent-row-highlight', () => ({ useFocusedAgentPaneKey: () => null }))
vi.mock('./worktree-card-send-target-inputs', () => ({
  selectSendTargetControlInputs: () => ({ targetMode: null, agentStatusEpoch: 0 }),
  selectSendTargetInputs: () => ({})
}))
vi.mock('@/lib/running-agent-targets', () => ({ deriveRunningAgentSendTargets: () => [] }))
vi.mock('./worktree-card-agents-expansion-state', () => ({
  useWorktreeAgentExpansionState: () => ({
    collapsedLineageParents: new Set(),
    compactRootListExpanded: true,
    toggleLineageParent: vi.fn(),
    toggleCompactRootList: vi.fn()
  })
}))
vi.mock('@/components/dashboard/agent-row-lineage-model', () => ({
  buildAgentRowLineageTree: (agents: unknown[]) => ({
    rootRows: agents,
    childrenByParentPaneKey: new Map()
  })
}))

function captureRow({
  agent,
  onActivate
}: {
  agent: { paneKey: string }
  onActivate: (tabId: string, paneKey: string) => void
}) {
  mocks.capturedActivations.push(onActivate)
  return <div data-pane-key={agent.paneKey} />
}

vi.mock('@/components/dashboard/DashboardAgentRow', () => ({ default: captureRow }))
vi.mock('./worktree-card-compact-agents', () => ({
  CompactAgentRow: captureRow,
  CompactAgentExpansion: ({ children }: { children: ReactNode }) => <>{children}</>,
  CompactAgentSummaryButton: () => null
}))

function agent(options: {
  terminalHandle?: string
  worker?: boolean
  rowSource?: 'live' | 'retained'
  state?: 'working' | 'done' | 'idle'
}) {
  const paneKey = makePaneKey('tab-worker', LEAF_ID)
  return {
    paneKey,
    tab: { id: 'tab-worker' },
    agentType: 'codex',
    rowSource: options.rowSource ?? 'live',
    state: options.state ?? 'working',
    startedAt: 1_000,
    entry: {
      paneKey,
      prompt: 'Implement the task',
      state: options.state ?? 'working',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: [],
      terminalHandle: options.terminalHandle,
      orchestration: options.worker
        ? { taskId: 'task-worker', dispatchId: 'ctx-worker' }
        : undefined
    }
  }
}

async function renderAndActivate(mode: 'compact' | 'full'): Promise<void> {
  mocks.displayMode = mode
  const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
  renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
  expect(mocks.capturedActivations).toHaveLength(1)
  mocks.capturedActivations[0]('tab-worker', makePaneKey('tab-worker', LEAF_ID))
  await Promise.resolve()
}

describe('WorktreeCardAgents exact Worker focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agents = []
    mocks.displayMode = 'full'
    mocks.capturedActivations = []
    mocks.state.tabsByWorktree = {}
    mocks.state.agentStatusByPaneKey = {}
    mocks.focusTerminalHandleForWorktree.mockResolvedValue('runtime')
  })

  it.each(['full', 'compact'] as const)(
    'reveals a background live Worker exactly in %s rows without generic activation',
    async (mode) => {
      mocks.agents = [agent({ terminalHandle: 'term-worker', worker: true })]

      await renderAndActivate(mode)

      expect(mocks.focusTerminalHandleForWorktree).toHaveBeenCalledTimes(1)
      expect(mocks.focusTerminalHandleForWorktree).toHaveBeenCalledWith({
        handle: 'term-worker',
        worktreeId: 'wt-1'
      })
      expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
      expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
      expect(mocks.addTerminalTab).not.toHaveBeenCalled()
    }
  )

  it('keeps the Worker row and fails closed when exact focus is unverifiable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.agents = [agent({ terminalHandle: 'term-worker', worker: true })]
    mocks.focusTerminalHandleForWorktree.mockRejectedValue(new Error('terminal_focus_unverifiable'))

    try {
      await renderAndActivate('full')
      await Promise.resolve()

      expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
      expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
      expect(mocks.addTerminalTab).not.toHaveBeenCalled()
      expect(mocks.capturedActivations).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(
        '[WorktreeCardAgents] exact Worker focus failed:',
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps no-handle sleeping non-Worker rows on generic activation', async () => {
    mocks.agents = [agent({ state: 'idle' })]

    await renderAndActivate('full')

    expect(mocks.focusTerminalHandleForWorktree).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
  })

  it('keeps retained rows inert even when a terminal handle is preserved', async () => {
    mocks.agents = [
      agent({ terminalHandle: 'term-retained', worker: true, rowSource: 'retained', state: 'done' })
    ]

    await renderAndActivate('full')

    expect(mocks.focusTerminalHandleForWorktree).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
