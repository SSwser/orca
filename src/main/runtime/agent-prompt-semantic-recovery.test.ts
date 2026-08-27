import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => {
  const promptWorktree = {
    path: '/tmp/worktree-a',
    head: 'abc',
    branch: 'feature/prompt-verification',
    isBare: false,
    isMainWorktree: false
  }
  return {
    listWorktrees: vi.fn().mockResolvedValue([promptWorktree]),
    listWorktreesStrict: vi.fn().mockResolvedValue([promptWorktree])
  }
})

describe('agent prompt semantic recovery', () => {
  afterEach(() => vi.useRealTimers())

  it('resumes semantic observation from a transport receipt without rewriting input', async () => {
    const { runtime, handle, write } = await createSemanticRecoveryRuntime()
    const observation = runtime.inspectTerminalWorkerPromptOperation(handle, promptOperation)
    setTimeout(() => runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now()), 100)
    await vi.advanceTimersByTimeAsync(150)

    await expect(observation).resolves.toMatchObject({ verdict: 'completed' })
    expect(write).not.toHaveBeenCalled()
  })

  it('reports submission_unconfirmed when resumed observation sees no turn edge', async () => {
    const { runtime, handle, write } = await createSemanticRecoveryRuntime()
    const rejected = expect(
      runtime.inspectTerminalWorkerPromptOperation(handle, promptOperation)
    ).rejects.toMatchObject({ code: 'submission_unconfirmed' })
    await vi.runAllTimersAsync()

    await rejected
    expect(write).not.toHaveBeenCalled()
  })
})

const promptOperation = {
  operationId: 'prompt-operation',
  payloadFingerprint: 'prompt-fingerprint'
}

async function createSemanticRecoveryRuntime() {
  vi.useFakeTimers()
  const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined)
  const write = vi.fn(() => {
    throw new Error('semantic observation must not write')
  })
  runtime.setPtyController({
    write,
    supportsWorkerPromptOperations: () => true,
    writeWorkerPromptOperation: async () => {
      throw new Error('semantic observation must not write an operation')
    },
    inspectWorkerPromptOperation: async () => ({
      verdict: 'completed',
      receipt: {
        ...promptOperation,
        sessionIncarnationId: 'prompt-incarnation',
        terminalHandle: handle,
        completedAt: Date.now(),
        semanticBaseline: {
          observedAt: Date.now(),
          permissionSequence: 0,
          workingSequence: 0,
          explicitWorkingStartedAt: null,
          outputSequence: 0,
          status: null
        }
      }
    }),
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, handle, write }
}
