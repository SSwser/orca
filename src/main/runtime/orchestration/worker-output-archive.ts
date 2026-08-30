import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import type { ExactWorkerProviderSession } from '../../../shared/orchestration-worker-output'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from './orchestration-error'
import {
  MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT,
  redactWorkerTerminalLines
} from './worker-transcript-payload'
import { readWorkerTranscript } from './worker-transcript-read'

// Bound the durable copy of raw terminal output; the tail end is the evidence that matters.
const TERMINAL_ARCHIVE_MAX_CHARS = 262_144

export type WorkerTranscriptPinArchive = {
  agent: AgentType
  providerSessionKey: string
  providerSessionId: string
  transcriptPath: string | null
  processIncarnation: string
  observedAfter: number
  endOffset?: number
  terminalFallback?: WorkerTerminalTailArchive
}

export type WorkerTranscriptSnapshotArchive = {
  version: 2
  agent: AgentType
  processIncarnation: string
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
}

export type WorkerTerminalTailArchive = {
  lines: string[]
  draft?: string
  truncated: boolean
  terminalStatus: string
  warnings: string[]
}

type WorkerTranscriptPinCapture = {
  kind: 'transcript_pin'
  content: WorkerTranscriptPinArchive
  status: 'captured'
}

type WorkerTranscriptSnapshotCapture = {
  kind: 'transcript_pin'
  content: WorkerTranscriptSnapshotArchive
  status: 'captured'
}

type WorkerTerminalTailCapture = {
  kind: 'terminal_tail'
  content: WorkerTerminalTailArchive
  status: 'captured' | 'empty'
}

export type WorkerOutputArchiveCapture = WorkerTranscriptSnapshotCapture | WorkerTerminalTailCapture

export type WorkerOutputArchiveInput = WorkerTranscriptPinCapture | WorkerTerminalTailCapture

// Freezes an inspectable output source before the live PTY is closed. Prefers the exact
// hook-reported provider transcript; falls back to bounded redacted terminal output. Throws
// typed archive_failed so release retains the live terminal when no evidence can be preserved.
export async function captureWorkerOutputArchive(args: {
  runtime: OrcaRuntimeService
  dispatchId: string
  terminalHandle: string
  attachedAtMs: number
}): Promise<WorkerOutputArchiveCapture> {
  const terminalRead = args.runtime
    .readTerminal(args.terminalHandle, {})
    .catch((error) => (error instanceof Error ? error : new Error(String(error))))
  const session = args.runtime.getExactWorkerProviderSession(args.terminalHandle, args.attachedAtMs)
  if (session) {
    const snapshot = await readWorkerTranscript({
      agent: session.agent,
      sessionId: session.providerSession.id,
      transcriptPath: session.providerSession.transcriptPath,
      limit: MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT
    }).catch(() => null)
    if (snapshot?.ok && snapshot.messages.length > 0) {
      return {
        kind: 'transcript_pin',
        status: 'captured',
        content: {
          version: 2,
          agent: session.agent,
          processIncarnation: session.processIncarnation,
          messages: snapshot.messages,
          limited: snapshot.limited,
          warnings: snapshot.warnings
        }
      }
    }
  }
  const terminal = await terminalRead
  if (terminal instanceof Error) {
    throw new OrchestrationError(
      'archive_failed',
      `Output could not be preserved for Dispatch ${args.dispatchId}; the terminal was retained. ${terminal.message}`
    )
  }
  return captureWorkerTerminalTail(terminal)
}

export function freezeWorkerOutputArchiveInput(args: {
  session: ExactWorkerProviderSession | null
  terminal: RuntimeTerminalRead
}): WorkerOutputArchiveInput {
  const terminalFallback = captureWorkerTerminalTail(args.terminal)
  if (!args.session) {
    return terminalFallback
  }
  return {
    kind: 'transcript_pin',
    status: 'captured',
    content: {
      agent: args.session.agent,
      providerSessionKey: args.session.providerSession.key,
      providerSessionId: args.session.providerSession.id,
      transcriptPath: args.session.providerSession.transcriptPath ?? null,
      processIncarnation: args.session.processIncarnation,
      observedAfter: args.session.observedAt,
      terminalFallback: terminalFallback.content
    }
  }
}

function captureWorkerTerminalTail(terminal: RuntimeTerminalRead): WorkerTerminalTailCapture {
  const redacted = redactWorkerTerminalLines([
    ...terminal.tail,
    ...(terminal.draft ? [terminal.draft] : [])
  ])
  const bounded = boundArchiveLines(redacted.lines)
  const draft = terminal.draft ? bounded.lines.at(-1) : undefined
  const lines = terminal.draft ? bounded.lines.slice(0, -1) : bounded.lines
  // Why: an exited PTY zeroes its tail immediately, so an empty capture is a distinct receipt,
  // not silent success — worker-read must be able to say why nothing is there.
  const empty = bounded.lines.every((line) => line.trim() === '')
  return {
    kind: 'terminal_tail',
    status: empty ? 'empty' : 'captured',
    content: {
      lines,
      ...(draft ? { draft } : {}),
      truncated: terminal.truncated || bounded.truncated,
      terminalStatus: terminal.status,
      warnings: empty
        ? [
            ...redacted.warnings,
            'The live terminal buffer was empty at release; structured transcript output was unavailable.'
          ]
        : redacted.warnings
    }
  }
}

function boundArchiveLines(lines: string[]): { lines: string[]; truncated: boolean } {
  let total = 0
  for (const line of lines) {
    total += line.length + 1
  }
  if (total <= TERMINAL_ARCHIVE_MAX_CHARS) {
    return { lines, truncated: false }
  }
  const kept: string[] = []
  let budget = TERMINAL_ARCHIVE_MAX_CHARS
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1
    if (cost > budget) {
      if (kept.length === 0 && budget > 1) {
        kept.unshift(lines[index].slice(-(budget - 1)))
      }
      break
    }
    kept.unshift(lines[index])
    budget -= cost
  }
  return { lines: kept, truncated: true }
}
