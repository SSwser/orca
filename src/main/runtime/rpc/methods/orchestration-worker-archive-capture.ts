import type { OrchestrationDb } from '../../orchestration/db'
import type {
  WorkerTerminalArchiveStatus,
  WorkerTerminalArchiveRow
} from '../../orchestration/worker-terminal-ownership'
import {
  captureWorkerOutputArchive,
  type WorkerTerminalTailArchive,
  type WorkerTranscriptPinArchive,
  type WorkerTranscriptSnapshotArchive
} from '../../orchestration/worker-output-archive'
import { readWorkerTranscript } from '../../orchestration/worker-transcript-read'
import { MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT } from '../../orchestration/worker-transcript-payload'
import { OrchestrationError } from '../../orchestration/orchestration-error'
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
    return materializeStoredArchive(args.db, existing)
  }
  const captured = await captureWorkerOutputArchive(args)
  return {
    kind: captured.kind,
    content: JSON.stringify(captured.content),
    source: captured.kind === 'transcript_pin' ? 'transcript' : 'terminal',
    status: captured.status
  }
}

async function materializeStoredArchive(
  db: OrchestrationDb,
  archive: WorkerTerminalArchiveRow
): Promise<WorkerTerminalArchiveCapture> {
  const resource = db.getWorkerTerminalResourceByOwner(archive.dispatch_id)
  if (!resource || resource.id !== archive.resource_id) {
    throw new OrchestrationError(
      'archive_failed',
      `The frozen archive for Dispatch ${archive.dispatch_id} is not bound to its current execution resource.`
    )
  }
  if (archive.kind === 'transcript_pin') {
    const content = JSON.parse(archive.content) as
      | WorkerTranscriptPinArchive
      | WorkerTranscriptSnapshotArchive
    if (content.processIncarnation !== resource.process_incarnation) {
      throw new OrchestrationError(
        'archive_failed',
        `The frozen transcript for Dispatch ${archive.dispatch_id} does not match its process incarnation.`
      )
    }
    if (isTranscriptSnapshot(content)) {
      return { source: 'transcript', status: 'captured' }
    }
    const transcript = await readWorkerTranscript({
      agent: content.agent,
      sessionId: content.providerSessionId,
      transcriptPath: content.transcriptPath ?? undefined,
      endOffset: content.endOffset,
      limit: MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT
    }).catch(() => null)
    if (transcript?.ok && transcript.messages.length > 0) {
      return {
        kind: 'transcript_pin',
        content: JSON.stringify({
          version: 2,
          agent: content.agent,
          processIncarnation: content.processIncarnation,
          messages: transcript.messages,
          limited: transcript.limited,
          warnings: transcript.warnings
        } satisfies WorkerTranscriptSnapshotArchive),
        source: 'transcript',
        status: 'captured'
      }
    }
    if (content.terminalFallback) {
      const empty = terminalArchiveIsEmpty(content.terminalFallback)
      return {
        kind: 'terminal_tail',
        content: JSON.stringify(content.terminalFallback),
        source: 'terminal',
        status: empty ? 'empty' : 'captured'
      }
    }
    throw new OrchestrationError(
      'archive_failed',
      `The frozen transcript for Dispatch ${archive.dispatch_id} could not be materialized and has no terminal fallback.`
    )
  }
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const empty = terminalArchiveIsEmpty(content)
  return { source: 'terminal', status: empty ? 'empty' : 'captured' }
}

function isTranscriptSnapshot(
  content: WorkerTranscriptPinArchive | WorkerTranscriptSnapshotArchive
): content is WorkerTranscriptSnapshotArchive {
  return 'version' in content && content.version === 2
}

function terminalArchiveIsEmpty(content: WorkerTerminalTailArchive): boolean {
  return [...content.lines, content.draft ?? ''].every((line) => line.trim() === '')
}
