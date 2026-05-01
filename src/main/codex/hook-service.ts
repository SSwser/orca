import { homedir } from 'os'
import { join } from 'path'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  readHooksJson,
  removeManagedCommands,
  writeHooksJson,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { ensureLauncherScript } from '../agent-hooks/launcher-script'
import { renderManagedHookLauncherCommand } from '../agent-hooks/launcher-registration'

// Why: PreToolUse/PostToolUse give the dashboard a live readout of the
// in-flight tool (name + input preview) between UserPromptSubmit and Stop.
// Without them, a long-running Codex turn looks like a silent gap after the
// prompt is submitted. We keep both events mapped to `working` (see
// normalizeCodexEvent); they do NOT mean "approval needed" — Codex's real
// approval signal flows through its separate `notify` callback (different
// install surface, different payload shape) and is deferred as a follow-up.
const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop'
] as const

function getConfigPath(): string {
  return join(homedir(), '.codex', 'hooks.json')
}

export class CodexHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Codex hooks.json'
      }
    }

    // Why: Report `partial` when only some managed events are registered so the
    // sidebar surfaces a degraded install rather than a false-positive
    // `installed`. Each CODEX_EVENTS entry must contain the managed command for
    // the integration to function end-to-end (e.g. PreToolUse is required for
    // permission-prompt detection per the comment above).
    const command = renderManagedHookLauncherCommand('codex')
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of CODEX_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command)
      )
      if (hasCommand) {
        presentCount += 1
      } else {
        missing.push(eventName)
      }
    }
    const managedHooksPresent = presentCount > 0
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail = `Managed hook missing for events: ${missing.join(', ')}`
    }
    return { agent: 'codex', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Codex hooks.json'
      }
    }

    ensureLauncherScript()
    const command = renderManagedHookLauncherCommand('codex')
    const nextHooks = { ...config.hooks }
    const managedEvents = new Set<string>(CODEX_EVENTS)

    // Why: match by script filename (not exact command string) so a fresh
    // install sweeps stale entries left by older builds, a different Electron
    // userData path (dev vs. prod), or the legacy per-agent script naming.
    // Without this, repeated installs accumulate duplicate hook entries
    // pointing at defunct scripts.
    const isManagedCommand = createManagedCommandMatcher([
      'codex-hook.sh',
      'codex-hook.cmd',
      'launcher.sh',
      'launcher.cmd'
    ])

    // Why: sweep managed entries out of events we no longer subscribe to
    // (e.g., PreToolUse from a prior install). Without this, users who
    // already had PreToolUse registered would keep firing stale hooks on
    // every auto-approved tool call after the app upgrade.
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName)) {
        continue
      }
      if (!Array.isArray(definitions)) {
        // Why: a malformed hooks.json entry (non-array value for an event name)
        // would make removeManagedCommands throw. Skip instead — we aren't
        // going to sweep something we can't parse, and the install() for
        // managed events below still runs.
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }

    for (const eventName of CODEX_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      const definition: HookDefinition = {
        hooks: [{ type: 'command', command }]
      }
      nextHooks[eventName] = [...cleaned, definition]
    }

    config.hooks = nextHooks
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Codex hooks.json'
      }
    }

    const nextHooks = { ...config.hooks }
    // Why: same broad matcher as install(), so remove() also cleans up stale
    // entries from older builds even if the current scriptPath has moved, and
    // sweeps both legacy per-agent scripts and the new shared launcher.
    const isManagedCommand = createManagedCommandMatcher([
      'codex-hook.sh',
      'codex-hook.cmd',
      'launcher.sh',
      'launcher.cmd'
    ])
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (!Array.isArray(definitions)) {
        // Why: a malformed hooks.json entry (non-array value for an event name)
        // would make removeManagedCommands throw. Skip instead — we have no
        // managed commands to remove from something we can't parse.
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }
    config.hooks = nextHooks
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const codexHookService = new CodexHookService()
