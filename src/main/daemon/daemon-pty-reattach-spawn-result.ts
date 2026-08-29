import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import type { PtySpawnResult } from '../providers/types'
import type { CreateOrAttachResult, GetSnapshotResult } from './types'

export function buildDaemonPtyReattachSpawnResult(args: {
  sessionId: string
  result: CreateOrAttachResult
  restartCustody: Pick<PtySpawnResult, 'restartCustody'> | Record<string, never>
  pid: number | null
  providerWslDistro: string | null | undefined
  providerSequence: PtySpawnResult['providerSequence']
  snapshot: NonNullable<GetSnapshotResult['snapshot']>
}): PtySpawnResult {
  const { result, snapshot } = args
  const providerSequence =
    typeof snapshot.outputSequence === 'number'
      ? { value: snapshot.outputSequence, generation: 'continued' as const }
      : args.providerSequence
  const snapshotPrefix = snapshot.scrollbackAnsi + snapshot.rehydrateSequences
  const snapshotFrame = snapshot.snapshotAnsi
  const kittyKeyboardFlags = parseTerminalKittyKeyboardFlags(snapshot.modes.kittyKeyboardFlags)
  return {
    id: args.sessionId,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...args.restartCustody,
    pid: args.pid,
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
    ...(result.agentSessionCreateOperation
      ? { agentSessionCreateOperation: result.agentSessionCreateOperation }
      : {}),
    ...(result.launchAgent ? { launchAgent: result.launchAgent } : {}),
    ...(args.providerWslDistro !== undefined ? { wslDistro: args.providerWslDistro } : {}),
    snapshot: snapshotPrefix + snapshotFrame,
    snapshotCols: snapshot.cols,
    snapshotRows: snapshot.rows,
    ...(snapshot.modes.alternateScreen && snapshotFrame && snapshot.frameRestoreAnsi
      ? {
          snapshotPrefixAnsi: snapshotPrefix,
          snapshotFrameAnsi: snapshotFrame,
          snapshotFrameRestoreAnsi: snapshot.frameRestoreAnsi
        }
      : {}),
    ...(providerSequence ? { providerSequence } : {}),
    ...(kittyKeyboardFlags !== undefined ? { snapshotKittyKeyboardFlags: kittyKeyboardFlags } : {}),
    ...(snapshot.terminalOwner ? { snapshotTerminalOwner: snapshot.terminalOwner } : {}),
    isReattach: true,
    isAlternateScreen: snapshot.modes.alternateScreen,
    ...(snapshot.lastTitle ? { lastTitle: snapshot.lastTitle } : {}),
    ...(snapshot.pendingEscapeTailAnsi
      ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
      : {})
  }
}
