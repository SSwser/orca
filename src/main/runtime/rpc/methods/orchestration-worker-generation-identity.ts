import { createHash } from 'node:crypto'

export type WorkerGenerationOperationIdentity = {
  operationId: string
  payloadFingerprint: string
}

function digest(value: string, encoding: 'hex' | 'base64url' = 'base64url'): string {
  return createHash('sha256').update(value).digest(encoding)
}

function operationIdentity(
  dispatchId: string,
  effectKind: 'worktree' | 'terminal' | 'authority' | 'prompt',
  payload: unknown
): WorkerGenerationOperationIdentity {
  const payloadFingerprint = digest(JSON.stringify(payload), 'hex')
  return {
    operationId: digest(
      `orca.worker-generation.v1\0${dispatchId}\0${effectKind}\0${payloadFingerprint}`
    ),
    payloadFingerprint
  }
}

function deterministicUuid(seed: string): string {
  const hex = digest(seed, 'hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

export function buildWorkerGenerationOperationIdentities(args: {
  dispatchId: string
  startOptions: unknown
}) {
  const worktree = operationIdentity(args.dispatchId, 'worktree', args.startOptions)
  const terminal = operationIdentity(args.dispatchId, 'terminal', {
    startOptions: args.startOptions,
    worktreeOperationId: worktree.operationId
  })
  const terminalTabId = deterministicUuid(`${terminal.operationId}:tab`)
  const terminalLeafId = deterministicUuid(`${terminal.operationId}:leaf`)
  const requestedTerminal = (args.startOptions as { terminal?: unknown } | null)?.terminal
  const terminalHandle =
    typeof requestedTerminal === 'string' && requestedTerminal.length > 0
      ? requestedTerminal
      : `term_${deterministicUuid(`${terminal.operationId}:handle`)}`
  return {
    worktree: {
      ...worktree,
      branchName: `orca-worker/${worktree.operationId.slice(0, 16)}`
    },
    terminal: {
      ...terminal,
      terminalHandle,
      tabId: terminalTabId,
      leafId: terminalLeafId
    },
    authority: operationIdentity(args.dispatchId, 'authority', {
      terminalOperationId: terminal.operationId,
      terminalHandle
    })
  }
}

export type WorkerGenerationOperationIdentities = ReturnType<
  typeof buildWorkerGenerationOperationIdentities
>

export function buildWorkerGenerationPromptOperation(args: {
  dispatchId: string
  terminalOperationId: string
  terminalHandle: string
  prompt: string
}): WorkerGenerationOperationIdentity {
  return operationIdentity(args.dispatchId, 'prompt', args)
}
