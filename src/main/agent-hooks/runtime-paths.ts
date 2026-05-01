import { join } from 'path'
import { app } from 'electron'

/**
 * Stable cross-install directory for managed hook scripts and the agent-hook
 * server's endpoint file.
 *
 * Why: hook script paths are written into *global* agent config files
 * (~/.claude/settings.json, ~/.cursor/hooks.json, etc.). If those paths vary
 * between dev and production builds — e.g. dev uses Electron's userData under
 * "Electron" and prod uses "orca" — dev installs permanently redirect global
 * configs to dev-only paths that production can no longer reach.
 *
 * `app.getPath('appData')` returns the OS app-data ROOT without an app-name
 * suffix:
 *   Windows: C:\Users\<user>\AppData\Roaming
 *   macOS:   ~/Library/Application Support
 *   Linux:   ~/.config
 *
 * Appending 'orca' produces the same stable path regardless of whether Electron
 * is running in dev mode (app name = "Electron") or as the packaged release
 * (app name = "orca"). Both the hook scripts and the endpoint file live here,
 * so a single global config entry always resolves correctly.
 */
export function getGlobalAgentHooksDir(): string {
  return join(app.getPath('appData'), 'orca', 'agent-hooks')
}

// Why: endpoint.json is read by spawned hook scripts to find the running
// agent-hook server; it must live at a single global path so dev and release
// builds resolve to the same file.
export function getAgentHookEndpointPath(): string {
  return join(getGlobalAgentHooksDir(), 'endpoint.json')
}

// Why: runtime.json records the currently provisioned hook runtime version so
// upgrades can detect stale installs across dev/release without scanning.
export function getAgentHookMetadataPath(): string {
  return join(getGlobalAgentHooksDir(), 'runtime.json')
}

// Why: the launcher script path is registered into global agent config files
// (~/.claude/settings.json, ~/.cursor/hooks.json, etc.), so it must be a
// stable, single global path; extension differs per OS shell convention.
export function getAgentHookLauncherPath(): string {
  return join(
    getGlobalAgentHooksDir(),
    process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
  )
}
