import type { PtyProcessInfo } from '../../providers/pty-process-info'
import { parsePtyRestartCustody, type PtyRestartCustody } from '../../../shared/pty-restart-custody'

export type WorkerTerminalHostScope =
  | { kind: 'local'; hostId: 'local'; restartCustody?: PtyRestartCustody }
  | { kind: 'wsl'; hostId: 'local'; distro: string }
  | { kind: 'ssh'; targetId: string }

export function parseWorkerTerminalHostScope(value: string | null): WorkerTerminalHostScope | null {
  if (!value) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const scope = parsed as Record<string, unknown>
  if (scope.kind === 'local' && scope.hostId === 'local') {
    const restartCustody =
      scope.restartCustody === undefined ? undefined : parsePtyRestartCustody(scope.restartCustody)
    if (scope.restartCustody !== undefined && !restartCustody) {
      return null
    }
    return {
      kind: 'local',
      hostId: 'local',
      ...(restartCustody ? { restartCustody } : {})
    }
  }
  if (
    scope.kind === 'wsl' &&
    scope.hostId === 'local' &&
    typeof scope.distro === 'string' &&
    scope.distro.length > 0
  ) {
    return { kind: 'wsl', hostId: 'local', distro: scope.distro }
  }
  if (scope.kind === 'ssh' && typeof scope.targetId === 'string' && scope.targetId.length > 0) {
    return { kind: 'ssh', targetId: scope.targetId }
  }
  return null
}

export function classifyWorkerTerminalProcessIncarnation(
  processIncarnation: string,
  sessions: readonly PtyProcessInfo[]
): 'live' | 'exited' | 'unverifiable' {
  const possibleMatches = sessions.filter((session) =>
    processIncarnation.startsWith(`${session.id}:`)
  )
  if (
    possibleMatches.some((session) => {
      const incarnationId = session.incarnationId
      if (!incarnationId || incarnationId !== incarnationId.trim()) {
        return false
      }
      return `${session.id}:${incarnationId}` === processIncarnation
    })
  ) {
    return 'live'
  }
  return possibleMatches.length > 0 ? 'unverifiable' : 'exited'
}

export function reconcileWorkerTerminalProcessIncarnation(
  processIncarnation: string,
  sessions: readonly PtyProcessInfo[],
  hostScope: WorkerTerminalHostScope,
  restartCustodyLiveness: 'live' | 'exited' | 'unverifiable' = 'unverifiable'
): 'live' | 'exited' | 'unverifiable' {
  const processLiveness = classifyWorkerTerminalProcessIncarnation(processIncarnation, sessions)
  if (processLiveness === 'live') {
    return processLiveness
  }
  if (hostScope.kind === 'ssh') {
    return 'unverifiable'
  }
  if (hostScope.kind !== 'local' || !hostScope.restartCustody) {
    return 'unverifiable'
  }
  if (restartCustodyLiveness === 'exited') {
    return 'exited'
  }
  return 'unverifiable'
}
