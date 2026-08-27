import { describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

function createSubprocess() {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let resolveConfirm: ((confirmed: boolean) => void) | undefined
  const confirmShellForeground = vi.fn(
    () => new Promise<boolean>((resolve) => void (resolveConfirm = resolve))
  )
  const handle = {
    pid: 999,
    getForegroundProcess: () => null,
    confirmShellForeground,
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    forceKill: () => {},
    signal: () => {},
    terminateOwnedTree: () => 'unavailable' as const,
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(cb: (code: number) => void) {
      onExit = cb
    },
    dispose: () => {}
  } as unknown as SubprocessHandle
  return {
    handle,
    confirmShellForeground,
    emit: (data: string) => onData?.(data),
    exit: (code: number) => onExit?.(code),
    confirm: (v: boolean) => resolveConfirm?.(v)
  }
}

describe('Session shell-owned recovery through the output barrier', () => {
  it('does not confirm shell ownership from historical replay bytes', () => {
    const sub = createSubprocess()
    const session = new Session({
      sessionId: 'historical-replay',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false,
      historySeedChunks: ['\x1b[?1049hOLD-TUI\x1b]133;D;137\x07old-shell-marker']
    } as never)

    expect(sub.confirmShellForeground).not.toHaveBeenCalled()
    expect(session.getSnapshot()?.terminalOwner).toBeUndefined()
    session.dispose()
  })

  it('answers concurrent runtime confirmations from one episode inspection', async () => {
    const sub = createSubprocess()
    const session = new Session({
      sessionId: 'concurrent-confirmations',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    } as never)

    await expect(session.confirmShellForeground()).resolves.toBe(false)
    expect(sub.confirmShellForeground).not.toHaveBeenCalled()

    sub.emit('\x1b[?1049hTUI\x1b]133;D;137\x07')
    const first = session.confirmShellForeground()
    const second = session.confirmShellForeground()
    expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1)
    sub.confirm(true)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('reuses parser confirmation for a concurrent runtime request', async () => {
    const sub = createSubprocess()
    const session = new Session({
      sessionId: 'parser-confirmation',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    } as never)

    sub.emit('\x1b[?1049hTUI\x1b]133;D;137\x07shell-marker')
    const runtimeConfirmation = session.confirmShellForeground()
    expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1)
    sub.confirm(true)

    await expect(runtimeConfirmation).resolves.toBe(true)
    await vi.waitFor(() => expect(session.getSnapshot()?.terminalOwner).toBe('shell'))
    session.dispose()
  })

  it('delivers post-kill shell output into the normalized snapshot instead of the discarded alt buffer', async () => {
    const sub = createSubprocess()
    const session = new Session({
      sessionId: 's1',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    } as never)

    sub.emit('before-tui\r\n\x1b[?1049hTUI-FRAME\x1b]133;D;137\x07SHELL-PROMPT-MARKER')
    await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1))
    sub.confirm(true)
    await session.settleShellOwnershipConfirmation()
    await new Promise((r) => setTimeout(r, 20))

    const snap = session.getSnapshot()!
    const content = (snap.scrollbackAnsi ?? '') + snap.snapshotAnsi
    expect(snap.terminalOwner).toBe('shell')
    expect(snap.modes.alternateScreen).toBe(false)
    expect(content).toContain('SHELL-PROMPT-MARKER')
    expect(content).toContain('before-tui')
    session.dispose()
  })

  it('keeps split escapes intact and revokes stale proof when a snapshot lands mid-sequence', async () => {
    const sub = createSubprocess()
    const session = new Session({
      sessionId: 's2',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    } as never)

    sub.emit('\x1b[?1049hTUI\x1b]133;D;137\x07')
    await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1))
    sub.confirm(true)
    await session.settleShellOwnershipConfirmation()
    await new Promise((r) => setTimeout(r, 20))
    expect(session.getSnapshot()?.terminalOwner).toBe('shell')

    // Live stream continues with a split mode-enable; snapshot lands inside the window.
    sub.emit('marker\x1b[?10')
    await new Promise((r) => setTimeout(r, 10))
    const mid = session.getSnapshot()!
    expect(mid.pendingEscapeTailAnsi).toBe('\x1b[?10')

    sub.emit('49h')
    await new Promise((r) => setTimeout(r, 20))
    const after = session.getSnapshot()!
    expect(after.modes.alternateScreen).toBe(true)
    expect(after.terminalOwner).toBeUndefined()
    expect(after.snapshotAnsi).not.toContain('49h')
    session.dispose()
  })

  it('flushes queued bytes to clients when the shell exits mid-proof instead of dropping them', async () => {
    const sub = createSubprocess()
    // Models TerminalHost.reapSession: exit and disposal are one synchronous chain.
    const session: Session = new Session({
      sessionId: 's3',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false,
      onExit: () => session.dispose()
    } as never)
    const received: string[] = []
    const exits: number[] = []
    session.attachClient({
      onData: (data: string) => received.push(data),
      onExit: (code: number) => exits.push(code)
    })

    sub.emit('\x1b[?1049hTUI\x1b]133;D;137\x07\r\nprompt-after-death')
    await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1))
    // The shell exits before the proof settles — sub-millisecond in production,
    // so it essentially always wins the race against the ps fork.
    sub.exit(0)

    expect(received.join('')).toContain('prompt-after-death')
    expect(exits).toEqual([0])
    // No injection either: an unproven episode flushes unmodified.
    expect(received.join('')).not.toContain('\x1b[?1049l')
  })

  it('flushes nested episodes stacked inside one proof window when the shell exits', async () => {
    const sub = createSubprocess()
    const session: Session = new Session({
      sessionId: 's4',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false,
      onExit: () => session.dispose()
    } as never)
    const received: string[] = []
    session.attachClient({ onData: (data: string) => received.push(data), onExit: () => {} })

    // Three alt-screen death cycles inside one proof window: each flush pass can
    // re-enter pending on the next trigger, so a single-level flush loses the tail.
    sub.emit(
      '\x1b[?1049hT1\x1b]133;D;1\x07AAA\x1b[?1049hT2\x1b]133;D;2\x07BBB\x1b[?1049hT3\x1b]133;D;3\x07CCC'
    )
    await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalled())
    sub.exit(0)

    const joined = received.join('')
    for (const marker of ['AAA', 'BBB', 'CCC']) {
      expect(joined).toContain(marker)
    }
    expect(joined).not.toContain('\x1b[?1049l')
  })
})
