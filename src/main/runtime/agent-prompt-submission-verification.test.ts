import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS,
  type AgentPromptActivity,
  isAgentPromptStalledError,
  readAgentPromptWaitText,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

function activity(overrides: Partial<AgentPromptActivity> = {}): AgentPromptActivity {
  return {
    observedAt: 1_000,
    generation: 1,
    permissionSequence: 2,
    workingSequence: 4,
    explicitWorkingStartedAt: null,
    outputSequence: 7,
    status: 'idle',
    ...overrides
  }
}

describe('agent prompt submission verification', () => {
  afterEach(() => vi.useRealTimers())

  it('reuses wait text while the PTY output sequence is unchanged', () => {
    const cache: { outputSequence?: number; waitText?: string } = {}
    const readWaitText = vi.fn(() => 'retained terminal tail')

    expect(readAgentPromptWaitText(cache, 7, readWaitText)).toBe('retained terminal tail')
    expect(readAgentPromptWaitText(cache, 7, readWaitText)).toBe('retained terminal tail')
    expect(readAgentPromptWaitText(cache, 8, readWaitText)).toBe('retained terminal tail')

    expect(readWaitText).toHaveBeenCalledTimes(2)
  })

  it('accepts an observed working transition', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    current = activity({ workingSequence: 5, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('accepts a completed lifecycle transition between polls', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    current = activity({ workingSequence: 5 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('does not accept an unrelated transition to a neutral title', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ status: null })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('reports stalled when no lifecycle transition occurs', async () => {
    vi.useFakeTimers()
    const current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('accepts a working transition after the former five-second deadline', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    await vi.advanceTimersByTimeAsync(5_000)
    current = activity({ workingSequence: 5, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('blocks when permission appears after submit', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_blocked')

    current = activity({ status: 'permission' })
    await vi.advanceTimersByTimeAsync(50)

    await rejected
  })

  it('blocks when permission appears and clears between polls', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_blocked')

    current = activity({ permissionSequence: 3 })
    await vi.advanceTimersByTimeAsync(50)

    await rejected
  })

  it('rejects an existing permission state', async () => {
    const current = activity({ status: 'permission' })

    await expect(
      verifyAgentPromptSubmission({ baseline: current, readActivity: () => current })
    ).rejects.toThrow('agent_prompt_blocked')
  })

  it('does not accept an unchanged working baseline', async () => {
    vi.useFakeTimers()
    const current = activity({ status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('accepts a hook working status recorded after the baseline', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    // No workingSequence edge: the window-gated synthetic title never ran (hidden window/headless).
    current = activity({ explicitWorkingStartedAt: 2_000, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('does not accept a hook working status that predates the baseline', async () => {
    vi.useFakeTimers()
    const current = activity({ explicitWorkingStartedAt: 2_000, status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('does not accept a working turn that began before the submit observation', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ explicitWorkingStartedAt: 900, status: 'working' })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  // Why: same-state hook pings refresh the row without starting a turn, so only the pinned
  // stateStartedAt may satisfy the check — a refreshed row must stay unproven.
  it('does not accept a refreshed hook row whose working turn did not restart', async () => {
    vi.useFakeTimers()
    let current = activity({ explicitWorkingStartedAt: 2_000 })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ explicitWorkingStartedAt: 2_000, outputSequence: 40 })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('accepts pane output after Enter when the agent was already working', async () => {
    vi.useFakeTimers()
    let current = activity({ status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    current = activity({ status: 'working', outputSequence: 8 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('does not accept pane output when the agent was idle at submit', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ outputSequence: 9 })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('accepts a genuine Codex hook edge delayed past the generic hook window', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      timeoutMs: resolveAgentPromptEffectTimeoutMs('codex')
    })

    await vi.advanceTimersByTimeAsync(18_000)
    current = activity({ explicitWorkingStartedAt: 19_000, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('gives hook-observed agents the longer effect window', () => {
    expect(resolveAgentPromptEffectTimeoutMs('codex')).toBe(AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS)
    expect(resolveAgentPromptEffectTimeoutMs('kimi')).toBe(AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS)
    expect(resolveAgentPromptEffectTimeoutMs('claude')).toBe(AGENT_PROMPT_EFFECT_TIMEOUT_MS)
    expect(resolveAgentPromptEffectTimeoutMs(null)).toBe(AGENT_PROMPT_EFFECT_TIMEOUT_MS)
  })

  it('recognizes a stalled verdict from a message or a relayed error code', () => {
    expect(isAgentPromptStalledError(new Error('agent_prompt_stalled'))).toBe(true)
    expect(isAgentPromptStalledError({ code: 'agent_prompt_stalled' })).toBe(true)
    expect(isAgentPromptStalledError(new Error('terminal_not_writable'))).toBe(false)
    expect(isAgentPromptStalledError(null)).toBe(false)
  })

  it('rejects a replaced terminal generation', async () => {
    const baseline = activity()

    await expect(
      verifyAgentPromptSubmission({
        baseline,
        readActivity: () => activity({ generation: 2 })
      })
    ).rejects.toThrow('terminal_handle_stale')
  })

  it('cancels while waiting for activity', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      signal: controller.signal
    })

    controller.abort()

    await expect(verification).rejects.toThrow('request_aborted')
  })
})
