export type AgentProcessPtySpawnTarget = {
  kind: 'agent-process'
  executable: string
  argv: string[]
  envPatch: {
    set: Record<string, string>
    delete: string[]
  }
  expectedProcess: string
}

export type PtySpawnTarget =
  | {
      kind: 'shell-command'
      command?: string
    }
  | AgentProcessPtySpawnTarget

export function isPtySpawnTarget(value: unknown): value is PtySpawnTarget {
  if (!value || typeof value !== 'object') {
    return false
  }
  const target = value as Partial<PtySpawnTarget>
  if (target.kind === 'shell-command') {
    return target.command === undefined || typeof target.command === 'string'
  }
  if (target.kind !== 'agent-process') {
    return false
  }
  const envPatch = target.envPatch as AgentProcessPtySpawnTarget['envPatch'] | undefined
  return (
    typeof target.executable === 'string' &&
    target.executable.length > 0 &&
    target.executable.length <= 4096 &&
    Array.isArray(target.argv) &&
    target.argv.length <= 256 &&
    target.argv.every((arg) => typeof arg === 'string') &&
    commandLineLength([target.executable, ...target.argv]) <= MAX_COMMAND_LINE_CHARS &&
    !!envPatch &&
    !!envPatch.set &&
    typeof envPatch.set === 'object' &&
    !Array.isArray(envPatch.set) &&
    Object.entries(envPatch.set).every(
      ([name, entry]) =>
        name.length > 0 && name.length <= 256 && typeof entry === 'string' && entry.length <= 32_768
    ) &&
    Array.isArray(envPatch.delete) &&
    envPatch.delete.every(
      (name) => typeof name === 'string' && name.length > 0 && name.length <= 256
    ) &&
    typeof target.expectedProcess === 'string' &&
    target.expectedProcess.length > 0 &&
    target.expectedProcess.length <= 128
  )
}
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from './windows-command-line-budget'
