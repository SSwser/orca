import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeCliCommandResolutionModule from '../../shared/node-cli-command-resolution'

const { existsSyncMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  resolveCodexCommandMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: existsSyncMock
}))
vi.mock('../../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCliCommandResolutionModule>()),
  resolveCodexCommand: resolveCodexCommandMock
}))
import { resolveLocalCodexAgentProcessTarget } from './local-codex-agent-process-target'

const prompt = 'first line\n"quoted" CJK 任务 `literal`'

function resolve(
  overrides: Partial<Parameters<typeof resolveLocalCodexAgentProcessTarget>[0]> = {}
) {
  return resolveLocalCodexAgentProcessTarget({
    prompt,
    platform: 'win32',
    agentArgs: '--sandbox workspace-write',
    agentEnv: { CODEX_HOME: 'C:\\profile' },
    ...overrides
  })
}

describe('local Codex agent-process target', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(true)
    resolveCodexCommandMock.mockReset().mockReturnValue('C:\\Program Files\\nodejs\\codex.cmd')
  })

  it('resolves the official Windows package to its native executable and one complete prompt argv', () => {
    expect(resolve()).toEqual({
      kind: 'agent-process',
      executable:
        'C:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
      argv: ['--sandbox', 'workspace-write', prompt],
      envPatch: { set: { CODEX_HOME: 'C:\\profile' }, delete: [] },
      expectedProcess: 'codex'
    })
  })

  it('accepts an absolute native executable without a shell', () => {
    resolveCodexCommandMock.mockReturnValue('/usr/local/bin/codex')
    expect(resolve({ platform: 'linux', agentArgs: '' })).toMatchObject({
      executable: '/usr/local/bin/codex',
      argv: [prompt]
    })
  })

  it('fails closed when an official wrapper has no matching native package', () => {
    existsSyncMock.mockReturnValue(false)
    expect(() => resolve()).toThrow('worker_execution_start_unsupported')
  })

  it.each([
    ['command override', { commandOverride: 'custom codex' }],
    ['unresolved executable', { platform: 'linux' as const }]
  ])('fails closed for %s', (_label, overrides) => {
    if (_label === 'unresolved executable') {
      resolveCodexCommandMock.mockReturnValue('codex')
    }
    expect(() => resolve(overrides)).toThrow('worker_execution_start_unsupported')
  })

  it('rejects an argv that exceeds the native process budget', () => {
    expect(() => resolve({ prompt: 'x'.repeat(40_000) })).toThrow(
      'worker_execution_start_argv_too_large'
    )
  })
})
