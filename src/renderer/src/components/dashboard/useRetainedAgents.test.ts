import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { collectRetainedAgentsOnDisappear } from './useRetainedAgents'

function makeAgentRow(args: {
  paneKey: string
  state: 'working' | 'blocked' | 'waiting' | 'done'
  interrupted?: boolean
}) {
  const entry: AgentStatusEntry = {
    state: args.state,
    prompt: 'Fix it',
    updatedAt: 100,
    stateStartedAt: 100,
    paneKey: args.paneKey,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    interrupted: args.interrupted
  }

  return {
    paneKey: args.paneKey,
    entry,
    tab: {
      id: 'tab-1',
      worktreeId: 'wt-1',
      title: 'Terminal',
      ptyId: null,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    agentType: 'claude' as const,
    state: args.state,
    startedAt: 1
  }
}

describe('collectRetainedAgentsOnDisappear', () => {
  it('retains a clean done row that disappeared naturally', () => {
    const previousAgents = new Map([
      ['tab-1:1', { row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done' }), worktreeId: 'wt-1' }]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {}
    })

    expect(result.toRetain).toHaveLength(1)
    expect(result.toRetain[0]?.entry.paneKey).toBe('tab-1:1')
    expect(result.consumedSuppressedPaneKeys).toEqual([])
  })

  it('does not retain an interrupted done row', () => {
    const previousAgents = new Map([
      [
        'tab-1:1',
        {
          row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done', interrupted: true }),
          worktreeId: 'wt-1'
        }
      ]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {}
    })

    expect(result.toRetain).toEqual([])
  })

  it('does not retain a clean done row when teardown suppressed that pane', () => {
    const previousAgents = new Map([
      ['tab-1:1', { row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done' }), worktreeId: 'wt-1' }]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: { 'tab-1:1': true }
    })

    expect(result.toRetain).toEqual([])
    expect(result.consumedSuppressedPaneKeys).toEqual(['tab-1:1'])
  })
})
