import { getAgentHookLauncherPath } from './runtime-paths'

// Why: every agent's hook config registers the same shape so dev/release
// switches don't accumulate divergent managed entries. Windows agents invoke
// the .cmd directly; POSIX agents invoke /bin/sh on the .sh launcher.
export function renderManagedHookLauncherCommand(): string {
  const launcherPath = getAgentHookLauncherPath()
  return process.platform === 'win32' ? launcherPath : `/bin/sh "${launcherPath}"`
}
