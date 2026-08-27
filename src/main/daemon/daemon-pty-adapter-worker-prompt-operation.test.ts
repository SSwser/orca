import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type { DaemonServer } from './daemon-server'

describe('DaemonPtyAdapter worker prompt protocol', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
  })

  afterEach(async () => {
    adapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('admits v38 without changing legacy input', async () => {
    const legacy = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      protocolVersion: 37
    })
    expect(adapter.supportsWorkerPromptOperations()).toBe(true)
    expect(legacy.supportsWorkerPromptOperations()).toBe(false)
    const request = vi.spyOn(DaemonClient.prototype, 'request')
    const notify = vi.spyOn(DaemonClient.prototype, 'notify')
    const operation = {
      operationId: 'prompt-operation',
      payloadFingerprint: 'prompt-fingerprint',
      sessionIncarnationId: 'session-incarnation',
      terminalHandle: 'term_worker',
      step: { kind: 'paste' as const, index: 0, count: 1, data: 'prompt' }
    }

    await expect(legacy.writeWorkerPromptOperation('session', operation)).rejects.toThrow(
      'worker_prompt_operation_unsupported'
    )
    expect(request).not.toHaveBeenCalledWith('writeWorkerPromptOperation', expect.anything())
    expect(() => legacy.write('session', 'ordinary input')).not.toThrow()
    expect(notify).toHaveBeenCalledWith('write', {
      sessionId: 'session',
      data: 'ordinary input'
    })
    legacy.dispose()
  })
})
