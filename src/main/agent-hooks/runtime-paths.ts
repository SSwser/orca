import { basename, join } from 'path'
import { app } from 'electron'

/**
 * Build-scoped directory for managed hook scripts and the agent-hook server's
 * endpoint file.
 *
 * Why: Orca dogfoods itself, so dev and packaged installs must not publish the
 * same hook runtime. The rest of the app already isolates profiles through
 * userData (`orca-dev` vs `orca` on Windows), and reusing that namespace here
 * keeps hook launchers, endpoint discovery, and runtime metadata inside the
 * same build boundary.
 *
 * We still anchor under `app.getPath('appData')` so the root lands in the OS
 * config directory rather than inside a nested Electron implementation path,
 * but the final app namespace comes from the active userData profile.
 */
export function getAgentHooksDir(): string {
  return join(app.getPath('appData'), basename(app.getPath('userData')), 'agent-hooks')
}

// Why: endpoint.json is read by spawned hook scripts to find the running
// agent-hook server; it must follow the active build namespace so dev and
// packaged installs do not discover each other's endpoint.
export function getAgentHookEndpointPath(): string {
  return join(getAgentHooksDir(), 'endpoint.json')
}

// Why: runtime.json records the currently provisioned hook runtime version, so
// it must stay inside the same build-scoped root as the managed scripts.
export function getAgentHookMetadataPath(): string {
  return join(getAgentHooksDir(), 'runtime.json')
}

// Why: the launcher script path is registered into global agent config files,
// but that registration should still point at the active build's runtime so a
// dev install cannot overwrite the packaged launch target.
export function getAgentHookLauncherPath(): string {
  return join(getAgentHooksDir(), process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh')
}
