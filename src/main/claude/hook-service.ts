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

const CLAUDE_EVENTS = [
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: PreToolUse gives the dashboard a live readout of the in-flight tool
  // (name + input preview) before it completes. Without it, a long-running
  // Bash/Task step looks like a silent gap between prompt and Stop.
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  }
] as const

function getConfigPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

export class ClaudeHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'claude',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Claude settings.json'
      }
    }

    // Why: Report `partial` when only some managed events are registered so the
    // sidebar surfaces a degraded install rather than a false-positive
    // `installed`. Each CLAUDE_EVENTS entry must contain the managed command for
    // the integration to function end-to-end.
    const command = renderManagedHookLauncherCommand('claude')
    const missing: string[] = []
    let presentCount = 0
    for (const event of CLAUDE_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command)
      )
      if (hasCommand) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
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
    return { agent: 'claude', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'claude',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Claude settings.json'
      }
    }

    ensureLauncherScript()
    const command = renderManagedHookLauncherCommand('claude')
    const nextHooks = { ...config.hooks }

    // Why: match by script filename (not exact command string) so a fresh
    // install sweeps stale entries left by older builds, a different Electron
    // userData path (dev vs. prod), or the legacy per-agent script naming.
    // Without this, repeated installs accumulate duplicate hook entries
    // pointing at defunct scripts.
    const isManagedCommand = createManagedCommandMatcher([
      'claude-hook.sh',
      'claude-hook.cmd',
      'launcher.sh',
      'launcher.cmd'
    ])

    for (const event of CLAUDE_EVENTS) {
      const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      const definition: HookDefinition = {
        ...event.definition,
        hooks: [{ type: 'command', command }]
      }
      nextHooks[event.eventName] = [...cleaned, definition]
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
        agent: 'claude',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Claude settings.json'
      }
    }

    const nextHooks = { ...config.hooks }
    // Why: same broad matcher as install(), so remove() also cleans up stale
    // entries from older builds even if the current scriptPath has moved, and
    // sweeps both legacy per-agent scripts and the new shared launcher.
    const isManagedCommand = createManagedCommandMatcher([
      'claude-hook.sh',
      'claude-hook.cmd',
      'launcher.sh',
      'launcher.cmd'
    ])
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      // Why: a malformed settings.json entry (non-array value for an event
      // name) would make removeManagedCommands throw via definitions.flatMap.
      // Skip — we cannot sweep something we cannot parse, and remove() must
      // fail open so a broken user config never blocks uninstall.
      if (!Array.isArray(definitions)) {
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

export const claudeHookService = new ClaudeHookService()
