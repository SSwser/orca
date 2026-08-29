import * as pty from 'node-pty'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import type { WindowsShellSpawnAttempt } from '../../providers/windows-shell-fallback-chain'
import { assignHostProcessToKillOnCloseJob } from '../../windows/windows-pty-job'

export type SpawnedDaemonPty = {
  process: pty.IPty
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  /** False when a wrapper owns the reported status, so no exit code may be read from it. */
  reportsChildExitStatus: boolean
  hostCrashContained: boolean
}

/** Walks the Windows PowerShell -> cmd.exe fallback chain when ConPTY rejects the primary shell. */
export function spawnNativeDaemonPty(args: {
  target:
    | {
        kind: 'shell'
        shellPath: string
        shellArgs: string[]
        windowsFallbackAttempts: WindowsShellSpawnAttempt[]
      }
    | { kind: 'agent-process'; executable: string; argv: string[] }
  spawnCwd: string
  env: Record<string, string>
  cols: number
  rows: number
  requireHostCrashContainment?: boolean
  onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
}): SpawnedDaemonPty {
  let reportsChildExitStatus = true
  let hostCrashContained = false
  const spawnAt = (shellPath: string, shellArgs: string[], cwd: string): pty.IPty => {
    const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    // Why: children inherit job membership, so the host job must exist before the first Windows PTY.
    if (process.platform === 'win32') {
      hostCrashContained = assignHostProcessToKillOnCloseJob()
      if (args.requireHostCrashContainment && !hostCrashContained) {
        throw new Error('daemon_crash_containment_unavailable')
      }
    }
    const proc = pty.spawn(wrapped.file, wrapped.args, {
      name: args.env.TERM ?? 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: args.env,
      // Why: bundled ConPTY has the wrap-marker behavior xterm expects.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {})
    })
    reportsChildExitStatus = hostReportsChildExitStatus(wrapped.file)
    args.onMacosTccSpawnStrategy?.(wrapped.file === shellPath ? 'direct' : 'wrapped')
    return proc
  }

  const executable =
    args.target.kind === 'agent-process' ? args.target.executable : args.target.shellPath
  const argv = args.target.kind === 'agent-process' ? args.target.argv : args.target.shellArgs
  try {
    const process_ = spawnAt(executable, argv, args.spawnCwd)
    return {
      process: process_,
      shellPath: executable,
      spawnCwd: args.spawnCwd,
      reportsChildExitStatus,
      hostCrashContained
    }
  } catch (primaryErr) {
    if (process.platform !== 'win32' || args.target.kind === 'agent-process') {
      throw primaryErr
    }
    for (const attempt of args.target.windowsFallbackAttempts.slice(1)) {
      try {
        const process = spawnAt(attempt.shellPath, attempt.shellArgs, attempt.effectiveCwd)
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        console.warn(
          `[daemon/pty] Primary shell "${args.target.shellPath}" failed (${message}), fell back to "${attempt.shellPath}"`
        )
        return {
          process,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs,
          reportsChildExitStatus,
          hostCrashContained
        }
      } catch {
        // This fallback shell also failed -- try the next link in the chain.
      }
    }
    throw primaryErr
  }
}
