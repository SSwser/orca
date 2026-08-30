import type {
  OrchestrationWorkerReadResult,
  OrchestrationWorkerReadSource
} from '../../../../shared/orchestration-worker-output'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalResourceRow
} from '../../orchestration/worker-terminal-ownership'
import type {
  WorkerTerminalTailArchive,
  WorkerTranscriptSnapshotArchive
} from '../../orchestration/worker-output-archive'
import { clampWorkerTranscriptLimit } from '../../orchestration/worker-transcript-payload'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from '../../orchestration/worker-output-cursor'

const ARCHIVED_TERMINAL_PAGE_LINES = 2_000

// Serves only materialized output after the live PTY is gone. Cursors stay Dispatch-scoped and
// source-pinned exactly like live reads.
export async function readArchivedWorkerOutput(args: {
  db: OrchestrationDb
  dispatchId: string
  workerState: string
  resource: WorkerTerminalResourceRow
  source?: OrchestrationWorkerReadSource
  cursor?: string | number
  limit?: number
}): Promise<OrchestrationWorkerReadResult> {
  const archive = args.db.getWorkerTerminalArchive(args.dispatchId)
  if (!archive) {
    throw new OrchestrationError(
      'archive_unavailable',
      `Dispatch ${args.dispatchId} was released without a preserved output archive.`
    )
  }
  if (archive.kind === 'transcript_pin') {
    if (args.source === 'terminal') {
      throw new OrchestrationError(
        'archive_unavailable',
        `Dispatch ${args.dispatchId} preserved structured transcript output only; terminal output was released.`
      )
    }
    const content = JSON.parse(archive.content) as WorkerTranscriptSnapshotArchive
    if (!isTranscriptSnapshot(content)) {
      throw new OrchestrationError(
        'archive_unavailable',
        `Dispatch ${args.dispatchId} has an unmaterialized transcript pin; release settlement is incomplete.`
      )
    }
    return readFrozenTranscript(args, archive, content)
  }
  if (args.source === 'transcript') {
    throw new OrchestrationError(
      'transcript_required',
      `Structured output is unavailable for released Dispatch ${args.dispatchId}: the archive holds terminal output only.`
    )
  }
  return readArchivedTerminalTail(args, archive)
}

function readFrozenTranscript(
  args: Parameters<typeof readArchivedWorkerOutput>[0],
  archive: WorkerTerminalArchiveRow,
  snapshot: WorkerTranscriptSnapshotArchive
): OrchestrationWorkerReadResult {
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'released-transcript-snapshot',
    args.resource.id,
    snapshot.processIncarnation,
    archive.created_at
  ])
  if (cursor && (cursor.source !== 'transcript' || cursor.sourceIdentity !== sourceIdentity)) {
    throw sourceChanged()
  }
  const start = Math.min(cursor?.position ?? 0, snapshot.messages.length)
  const end = Math.min(start + clampWorkerTranscriptLimit(args.limit), snapshot.messages.length)
  const nextCursor = encodeWorkerOutputCursor(args.dispatchId, 'transcript', sourceIdentity, end)
  return {
    dispatchId: args.dispatchId,
    source: 'transcript',
    sourceIdentity,
    provider: snapshot.agent,
    transcript: {
      messages: snapshot.messages.slice(start, end),
      nextCursor,
      limited: end < snapshot.messages.length,
      returnedMessageCount: end - start
    },
    cursor: nextCursor,
    status: { worker: args.workerState, terminal: 'exited' },
    fallbackReason: null,
    warnings: [
      ...snapshot.warnings,
      ...(snapshot.limited
        ? ['Older transcript messages were omitted from the bounded archive.']
        : [])
    ],
    archived: true
  }
}

function isTranscriptSnapshot(
  content: WorkerTranscriptSnapshotArchive
): content is WorkerTranscriptSnapshotArchive {
  return 'version' in content && content.version === 2
}

function readArchivedTerminalTail(
  args: Parameters<typeof readArchivedWorkerOutput>[0],
  archive: WorkerTerminalArchiveRow
): OrchestrationWorkerReadResult {
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'released-terminal',
    args.resource.id,
    archive.created_at
  ])
  if (cursor && cursor.source !== 'terminal') {
    throw sourceChanged()
  }
  if (cursor && (cursor.legacy || cursor.sourceIdentity !== sourceIdentity)) {
    throw sourceChanged()
  }
  const start = Math.min(cursor?.position ?? 0, content.lines.length)
  const pageSize = Math.max(1, Math.min(args.limit ?? ARCHIVED_TERMINAL_PAGE_LINES, 10_000))
  const end = Math.min(start + pageSize, content.lines.length)
  const tail = content.lines.slice(start, end)
  const nextCursor =
    end < content.lines.length
      ? encodeWorkerOutputCursor(args.dispatchId, 'terminal', sourceIdentity, end)
      : null
  return {
    dispatchId: args.dispatchId,
    source: 'terminal',
    sourceIdentity,
    terminal: {
      handle: args.resource.terminal_handle,
      status: 'exited',
      tail,
      ...(!cursor && content.draft ? { draft: content.draft } : {}),
      truncated: content.truncated,
      nextCursor,
      returnedLineCount: tail.length
    },
    cursor: nextCursor,
    status: { worker: args.workerState, terminal: 'exited' },
    fallbackReason: null,
    warnings: content.warnings,
    archived: true
  }
}

function sourceChanged(): OrchestrationError {
  return new OrchestrationError(
    'source_changed',
    'The worker output source changed. Start a fresh worker-read without the old cursor.'
  )
}
