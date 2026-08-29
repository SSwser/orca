import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'
import type { TerminalHostOptions } from './terminal-host-options'

describe('TerminalHost Agent Session operation', () => {
  let host: TerminalHost
  let spawnSubprocess: Mock<TerminalHostOptions['spawnSubprocess']>

  beforeEach(() => {
    spawnSubprocess = vi.fn<TerminalHostOptions['spawnSubprocess']>(() => createSubprocess())
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    await host.dispose()
  })

  it('replays only the exact Agent Session create operation', async () => {
    const operation = {
      operationId: 'a'.repeat(43),
      payloadFingerprint: 'b'.repeat(64)
    }
    const request = {
      sessionId: 'session-operation',
      cols: 80,
      rows: 24,
      agentSessionCreateOperation: operation,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    }
    const first = await host.createOrAttach(request)
    const replay = await host.createOrAttach(request)

    expect(first).toMatchObject({ isNew: true, agentSessionCreateOperation: operation })
    expect(replay).toMatchObject({ isNew: false, agentSessionCreateOperation: operation })
    expect(host.listSessions()).toContainEqual(
      expect.objectContaining({
        sessionId: request.sessionId,
        agentSessionCreateOperation: operation
      })
    )
    expect(spawnSubprocess).toHaveBeenCalledOnce()
    await expect(
      host.createOrAttach({
        ...request,
        agentSessionCreateOperation: { ...operation, payloadFingerprint: 'c'.repeat(64) }
      })
    ).rejects.toThrow('agent_session_operation_conflict')
    expect(spawnSubprocess).toHaveBeenCalledOnce()
  })
})

function createSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 99999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn()
  }
}
