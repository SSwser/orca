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

// Why: Gemini CLI fires `BeforeAgent` when a turn starts and `AfterAgent` when
// it completes. `AfterTool` marks the resumption of model work after a tool
// call, which maps back to `working`. Gemini has no permission-prompt hook
// (approvals flow through inline UI), so Orca cannot surface a waiting state
// for Gemini — that is an upstream limitation, not an Orca bug.
//
// PreToolUse surfaces the current tool name + input preview (e.g.
// `read_file: src/foo.ts`) so long-running tool calls aren't a silent gap
// between BeforeAgent and AfterAgent. PostToolUse is intentionally omitted —
// AfterTool already signals "back to working" and the tool name from
// PreToolUse is what we show; PostToolUse would be a redundant fire.
const GEMINI_EVENTS = ['BeforeAgent', 'AfterAgent', 'AfterTool', 'PreToolUse'] as const

function getConfigPath(): string {
  return join(homedir(), '.gemini', 'settings.json')
}

export class GeminiHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const command = renderManagedHookLauncherCommand('gemini')
    const missing: string[] = []
    let presentCount = 0
    for (const eventName of GEMINI_EVENTS) {
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
    return { agent: 'gemini', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    ensureLauncherScript()
    const command = renderManagedHookLauncherCommand('gemini')
    const nextHooks = { ...config.hooks }

    // Why: match by script filename (not exact command string) so a fresh
    // install sweeps stale entries left by older builds, a different Electron
    // userData path (dev vs. prod), or the legacy per-agent script naming.
    // Without this, repeated installs accumulate duplicate hook entries
    // pointing at defunct scripts.
    const isManagedCommand = createManagedCommandMatcher([
      'gemini-hook.sh',
      'gemini-hook.cmd',
      'launcher.sh',
      'launcher.cmd'
    ])

    for (const eventName of GEMINI_EVENTS) {
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
        agent: 'gemini',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Gemini settings.json'
      }
    }

    const nextHooks = { ...config.hooks }
    // Why: same broad matcher as install(), so remove() also cleans up stale
    // entries from older builds even if the current scriptPath has moved, and
    // sweeps both legacy per-agent scripts and the new shared launcher.
    const isManagedCommand = createManagedCommandMatcher([
      'gemini-hook.sh',
      'gemini-hook.cmd',
      'launcher.sh',
      'launcher.cmd'
    ])
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      // Why: a malformed settings.json entry (non-array value for an event
      // name) would make removeManagedCommands throw via definitions.flatMap.
      // Skip — remove() must fail open so a broken user config never blocks
      // uninstall.
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

export const geminiHookService = new GeminiHookService()
