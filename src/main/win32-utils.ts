import { execFileSync } from 'node:child_process'

/**
 * Full path to icacls.exe. Electron's main process may have a stripped PATH
 * that excludes System32, causing bare `icacls` to throw ENOENT.
 */
export function getIcaclsExePath(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\icacls.exe`
}

/**
 * Full path to cmd.exe, respecting the ComSpec convention used elsewhere in
 * the codebase (hooks.ts, repo.ts, ssh-connection-utils.ts).
 * Falls back to SystemRoot-based path if ComSpec is unset.
 */
export function getCmdExePath(): string {
  return process.env.ComSpec || `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`
}

/** Whether a resolved command path points to a Windows batch script (.cmd/.bat). */
export function isWindowsBatchScript(commandPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)
}

/** Check whether an error is a Windows permission error (EACCES or EPERM). */
export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'EACCES' ||
      (error as NodeJS.ErrnoException).code === 'EPERM')
  )
}

/**
 * Grant Full Control (OI)(CI)(F) on a directory for the current user.
 * Used to fix Chromium's Protected DACL propagation which leaves child
 * directories with Inherit-Only ACEs that deny direct file creation.
 *
 * Why /grant:r not /inheritance:e: Chromium's ACEs carry the Inherit-Only
 * flag when propagated to children, so restoring inheritance does not grant
 * the directory itself any effective permissions. An explicit ACE survives
 * future DACL propagation and grants create-file rights.
 */
export function grantDirAcl(dirPath: string, options?: { recursive?: boolean }): void {
  const username = process.env.USERNAME
  if (!username) {
    return
  }
  const args = [dirPath, '/grant:r', `${username}:(OI)(CI)(F)`]
  if (options?.recursive) {
    args.push('/T', '/C')
  }
  execFileSync(getIcaclsExePath(), args, { stdio: 'ignore', timeout: 10000 })
}

/**
 * Resolve spawn parameters for a command that may be a Windows batch script.
 *
 * Why: Node's spawn() cannot execute .cmd/.bat files directly without
 * shell:true, but shell:true with an args array triggers DEP0190 because
 * args are concatenated, not escaped. Routing through cmd.exe /c explicitly
 * avoids the deprecation warning while passing args correctly.
 */
export function getSpawnArgsForWindows(
  command: string,
  args: string[]
): { spawnCmd: string; spawnArgs: string[] } {
  if (isWindowsBatchScript(command)) {
    return { spawnCmd: getCmdExePath(), spawnArgs: ['/c', command, ...args] }
  }
  return { spawnCmd: command, spawnArgs: args }
}
