import type { Session } from './session'
import type { TerminalSnapshot } from './types'

export function getTerminalHostSnapshot(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
  opts: { scrollbackRows?: number }
): TerminalSnapshot | null {
  const session = sessions.get(sessionId)
  return session?.isAlive === true ? session.getSnapshot(opts) : null
}

export async function confirmTerminalHostShellForeground(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (session?.isAlive !== true) {
    return false
  }
  const confirmed = await session.confirmShellForeground()
  // A confirmation that outlives the exact session cannot authorize its successor.
  return confirmed && sessions.get(sessionId) === session && session.isAlive
}

export async function getSettledTerminalHostSnapshot(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
  opts: { scrollbackRows?: number }
): Promise<TerminalSnapshot | null> {
  const session = sessions.get(sessionId)
  if (!session || !session.isAlive) {
    return null
  }
  await session.settleShellOwnershipConfirmation()
  return session.getSnapshot(opts)
}
