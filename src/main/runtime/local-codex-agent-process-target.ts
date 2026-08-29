import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import { resolveAgentSessionOptionLaunch } from '../../shared/agent-session-option-launch'
import { resolveCodexCommand } from '../../shared/node-cli-command-resolution'
import type { AgentProcessPtySpawnTarget } from '../../shared/pty-spawn-target'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'

function resolveWindowsCodexNativeExecutable(
  resolvedCommand: string,
  architecture: NodeJS.Architecture
): string | null {
  if (extname(resolvedCommand).toLowerCase() === '.exe') {
    return resolvedCommand
  }
  const target =
    architecture === 'x64'
      ? ['codex-win32-x64', 'x86_64-pc-windows-msvc']
      : architecture === 'arm64'
        ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc']
        : null
  if (!target) {
    return null
  }
  const packageRoot = join(dirname(resolvedCommand), 'node_modules', '@openai', 'codex')
  const executableSuffix = ['vendor', target[1], 'bin', 'codex.exe']
  const candidates = [
    join(packageRoot, 'node_modules', '@openai', target[0], ...executableSuffix),
    join(packageRoot, ...executableSuffix)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function fingerprintAgentProcessTarget(target: AgentProcessPtySpawnTarget): string {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex')
}

export function resolveLocalCodexAgentProcessTarget(args: {
  prompt: string
  platform: NodeJS.Platform
  commandOverride?: string
  agentArgs: string
  agentEnv: Record<string, string>
  launchPreferences?: AgentLaunchPreferences
  architecture?: NodeJS.Architecture
}): AgentProcessPtySpawnTarget {
  if (args.commandOverride?.trim()) {
    throw new Error('worker_execution_start_unsupported')
  }
  const shell = args.platform === 'win32' ? 'powershell' : 'posix'
  const configuredArgs = tokenizeStartupCommand(args.agentArgs, shell)
  if (!configuredArgs.ok || configuredArgs.spans.some((span) => span.divergesFromShell)) {
    throw new Error('worker_execution_start_unsupported')
  }
  const sessionOptions = args.launchPreferences
    ? {
        ...(args.launchPreferences.model ? { model: args.launchPreferences.model } : {}),
        ...(args.launchPreferences.effort ? { effort: args.launchPreferences.effort } : {}),
        ...(args.launchPreferences.mode ? { mode: args.launchPreferences.mode } : {})
      }
    : undefined
  const optionArgs = resolveAgentSessionOptionLaunch(
    'codex',
    sessionOptions,
    configuredArgs.tokens
  ).args
  const codexArgs = [...optionArgs, ...configuredArgs.tokens, args.prompt]
  const resolvedCommand = resolveCodexCommand({ platform: args.platform })
  if (!isAbsolute(resolvedCommand)) {
    throw new Error('worker_execution_start_unsupported')
  }

  let executable = resolvedCommand
  let argv = codexArgs
  if (args.platform === 'win32') {
    const nativeExecutable = resolveWindowsCodexNativeExecutable(
      resolvedCommand,
      args.architecture ?? process.arch
    )
    if (!nativeExecutable) {
      throw new Error('worker_execution_start_unsupported')
    }
    executable = nativeExecutable
  }
  if (commandLineLength([executable, ...argv]) > MAX_COMMAND_LINE_CHARS) {
    throw new Error('worker_execution_start_argv_too_large')
  }
  return {
    kind: 'agent-process',
    executable,
    argv,
    envPatch: { set: { ...args.agentEnv }, delete: [] },
    expectedProcess: 'codex'
  }
}
