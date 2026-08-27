import type {
  WorkerPromptOperationIdentity,
  WorkerPromptOperationInspection,
  WorkerPromptOperationReceipt,
  WorkerPromptOperationRequest
} from '../../shared/worker-prompt-operation'

type ActiveWorkerPromptOperation = {
  identity: WorkerPromptOperationIdentity
  nextPasteIndex: number
  pasteCount: number
}

const MAX_COMPLETED_OPERATIONS = 32

export class SessionWorkerPromptOperationLedger {
  private current: ActiveWorkerPromptOperation | undefined
  private readonly completed = new Map<string, WorkerPromptOperationReceipt>()

  write(
    request: WorkerPromptOperationRequest,
    admitted: boolean,
    writeAcknowledged: (data: string) => boolean
  ): { accepted: boolean } {
    if (!admitted) {
      return { accepted: false }
    }
    const completed = this.completed.get(request.operationId)
    if (completed) {
      return { accepted: matchesIdentity(completed, request) }
    }
    if (this.current && !matchesIdentity(this.current.identity, request)) {
      return { accepted: false }
    }
    if (!this.current) {
      return this.start(request, writeAcknowledged)
    }
    if (request.step.kind === 'paste') {
      return this.writePaste(request, writeAcknowledged)
    }
    if (
      this.current.nextPasteIndex !== this.current.pasteCount ||
      !writeAcknowledged(request.step.data)
    ) {
      return { accepted: false }
    }
    const receipt = {
      ...this.current.identity,
      completedAt: Date.now(),
      semanticBaseline: request.step.semanticBaseline
    }
    this.completed.set(receipt.operationId, receipt)
    while (this.completed.size > MAX_COMPLETED_OPERATIONS) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.completed.delete(oldest)
    }
    this.current = undefined
    return { accepted: true }
  }

  inspect(identity: WorkerPromptOperationIdentity): WorkerPromptOperationInspection {
    const completed = this.completed.get(identity.operationId)
    if (completed) {
      return matchesIdentity(completed, identity)
        ? { verdict: 'completed', receipt: completed }
        : { verdict: 'conflict' }
    }
    if (!this.current) {
      return { verdict: 'not_started' }
    }
    if (!matchesIdentity(this.current.identity, identity)) {
      return { verdict: 'conflict' }
    }
    return { verdict: 'unverifiable' }
  }

  private start(
    request: WorkerPromptOperationRequest,
    writeAcknowledged: (data: string) => boolean
  ): { accepted: boolean } {
    if (
      request.step.kind !== 'paste' ||
      request.step.index !== 0 ||
      request.step.count < 1 ||
      !writeAcknowledged(request.step.data)
    ) {
      return { accepted: false }
    }
    this.current = {
      identity: copyIdentity(request),
      nextPasteIndex: 1,
      pasteCount: request.step.count
    }
    return { accepted: true }
  }

  private writePaste(
    request: WorkerPromptOperationRequest,
    writeAcknowledged: (data: string) => boolean
  ): { accepted: boolean } {
    if (
      request.step.kind !== 'paste' ||
      request.step.index !== this.current?.nextPasteIndex ||
      request.step.count !== this.current.pasteCount ||
      !writeAcknowledged(request.step.data)
    ) {
      return { accepted: false }
    }
    this.current.nextPasteIndex++
    return { accepted: true }
  }
}

function copyIdentity(identity: WorkerPromptOperationIdentity): WorkerPromptOperationIdentity {
  return {
    operationId: identity.operationId,
    payloadFingerprint: identity.payloadFingerprint,
    sessionIncarnationId: identity.sessionIncarnationId,
    terminalHandle: identity.terminalHandle
  }
}

function matchesIdentity(
  left: WorkerPromptOperationIdentity,
  right: WorkerPromptOperationIdentity
): boolean {
  return (
    left.operationId === right.operationId &&
    left.payloadFingerprint === right.payloadFingerprint &&
    left.sessionIncarnationId === right.sessionIncarnationId &&
    left.terminalHandle === right.terminalHandle
  )
}
