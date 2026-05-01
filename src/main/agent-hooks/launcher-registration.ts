import { getAgentHookLauncherPath } from './runtime-paths'

// Why: every agent's hook config registers the same launcher script but passes
// the agent name as a quoted argument so the launcher can dispatch to
// /hook/<agent>. Windows invokes the .cmd directly; POSIX wraps via /bin/sh.
export function renderManagedHookLauncherCommand(agent: string): string {
  const launcherPath = getAgentHookLauncherPath()
  const quotedPath = `"${launcherPath}"`
  return process.platform === 'win32' ? `${quotedPath} ${agent}` : `/bin/sh ${quotedPath} ${agent}`
}
