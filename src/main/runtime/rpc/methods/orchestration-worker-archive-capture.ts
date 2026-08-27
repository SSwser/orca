import type { OrchestrationDb } from '../../orchestration/db'
import type {
  WorkerTerminalArchiveStatus,
  WorkerTerminalArchiveRow
} from '../../orchestration/worker-terminal-ownership'
import {
  captureWorkerOutputArchive,
  type WorkerTerminalTailArchive
} from '../../orchestration/worker-output-archive'
import type { OrcaRuntimeService } from '../../orca-runtime'

export type WorkerTerminalArchiveCapture = {
  kind?: 'transcript_pin' | 'terminal_tail'
  content?: string
  source: 'transcript' | 'terminal'
  status: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
}

export async function captureWorkerTerminalArchiveOnce(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  attachedAtMs: number
}): Promise<WorkerTerminalArchiveCapture> {
  const existing = args.db.getWorkerTerminalArchive(args.dispatchId)
  if (existing) {
    return summarizeStoredArchive(existing)
  }
  const captured = await captureWorkerOutputArchive(args)
  return {
    kind: captured.kind,
    content: JSON.stringify(captured.content),
    source: captured.kind === 'transcript_pin' ? 'transcript' : 'terminal',
    status: captured.status
  }
}

function summarizeStoredArchive(archive: WorkerTerminalArchiveRow): WorkerTerminalArchiveCapture {
  if (archive.kind === 'transcript_pin') {
    return { source: 'transcript', status: 'captured' }
  }
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const empty = content.lines.every((line) => line.trim() === '')
  return { source: 'terminal', status: empty ? 'empty' : 'captured' }
}
