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
  effectKind: 'worktree' | 'execution_start',
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
  const { executionTargetFingerprint: _executionTargetFingerprint, ...topologyStartOptions } =
    (args.startOptions as Record<string, unknown> | null) ?? {}
  const worktree = operationIdentity(args.dispatchId, 'worktree', topologyStartOptions)
  const executionSeed = operationIdentity(args.dispatchId, 'execution_start', {
    startOptions: args.startOptions,
    worktreeOperationId: worktree.operationId
  })
  const terminalTabId = deterministicUuid(`${worktree.operationId}:tab`)
  const terminalLeafId = deterministicUuid(`${worktree.operationId}:leaf`)
  const requestedTerminal = (args.startOptions as { terminal?: unknown } | null)?.terminal
  const terminalHandle =
    typeof requestedTerminal === 'string' && requestedTerminal.length > 0
      ? requestedTerminal
      : `term_${deterministicUuid(`${worktree.operationId}:handle`)}`
  return {
    worktree: {
      ...worktree,
      branchName: `orca-worker/${worktree.operationId.slice(0, 16)}`
    },
    executionStart: {
      ...executionSeed,
      terminalHandle,
      tabId: terminalTabId,
      leafId: terminalLeafId
    }
  }
}

export type WorkerGenerationOperationIdentities = ReturnType<
  typeof buildWorkerGenerationOperationIdentities
>

export function buildWorkerExecutionStartOperation(args: {
  dispatchId: string
  executionSeedOperationId: string
  terminalHandle: string
  prompt: string
  capability: string
  targetFingerprint: string
}): WorkerGenerationOperationIdentity {
  return operationIdentity(args.dispatchId, 'execution_start', args)
}
