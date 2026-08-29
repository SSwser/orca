import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'
import type { PtySpawnTarget } from '../../shared/pty-spawn-target'

export type TerminalHostOptions = {
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    target?: PtySpawnTarget
    startupCommandDelivery?: StartupCommandDelivery
    launchAgent?: TuiAgent
    /** Refuse a Windows spawn unless daemon death will reap the PTY tree. */
    requireHostCrashContainment?: boolean
    shellOverride?: string
    terminalWindowsWslDistro?: string | null
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
    isCanceled?: () => boolean
    cancelSignal?: AbortSignal
    // Async production spawns and sync test stubs share this boundary.
  }) => SubprocessHandle | Promise<SubprocessHandle>
  // Why: login-session death detection (#7936) needs subprocess exits even when no client is attached.
  onSessionReaped?: (sessionId: string) => void
  /** Reports a shell-readiness outcome worth diagnosing. Why threaded rather
   *  than console: the detached daemon runs with stdio 'ignore', so the only
   *  durable sink is its NDJSON file log. */
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
  // Why: graceful shutdown checkpoints must finish in-process before teardown.
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
  // Why: tests need deterministic tombstone eviction without thousands of sessions.
  maxTombstones?: number
}
