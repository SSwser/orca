import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type { DaemonServer } from './daemon-server'

describe('DaemonPtyAdapter shell ownership', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let subprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return subprocess
    })
    dir = harness.dir
    server = harness.server
    adapter = harness.adapter
  })

  afterEach(async () => {
    adapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('publishes shell ownership only after the daemon proves the live PTY tree', async () => {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    subprocess.confirmShellForeground.mockResolvedValue(true)
    subprocess._simulateData('\x1b[?1049h\x1b[?1003h\x1b[?1006hTUI\x1b]133;D;137\x07shell-marker')

    await vi.waitFor(async () => {
      await expect(adapter.getBufferSnapshot(id)).resolves.toMatchObject({
        alternateScreen: false,
        terminalOwner: 'shell'
      })
    })
    await expect(adapter.confirmShellForeground(id)).resolves.toBe(true)
    expect(subprocess.confirmShellForeground).toHaveBeenCalledTimes(1)
  })

  it('preserves live TUI modes when the daemon cannot prove shell ownership', async () => {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    subprocess._simulateData(
      '\x1b[?1049h\x1b[?1003h\x1b[?1006hLIVE-TUI\x1b]133;D;0\x07nested-shell'
    )

    await vi.waitFor(() => expect(subprocess.confirmShellForeground).toHaveBeenCalledTimes(1))
    const snapshot = await adapter.getBufferSnapshot(id)
    expect(snapshot?.alternateScreen).toBe(true)
    expect(snapshot?.terminalOwner).toBeUndefined()
  })
})
