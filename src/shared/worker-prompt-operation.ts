export type WorkerPromptOperationIdentity = {
  operationId: string
  payloadFingerprint: string
  sessionIncarnationId: string
  terminalHandle: string
}

export type WorkerPromptSemanticBaseline = {
  observedAt: number
  permissionSequence: number
  workingSequence: number
  explicitWorkingStartedAt: number | null
  outputSequence: number
  status: 'working' | 'permission' | 'idle' | null
}

export type WorkerPromptOperationStep =
  | { kind: 'paste'; index: number; count: number; data: string }
  | { kind: 'submit'; data: string; semanticBaseline: WorkerPromptSemanticBaseline }

export type WorkerPromptOperationRequest = WorkerPromptOperationIdentity & {
  step: WorkerPromptOperationStep
}

export type WorkerPromptOperationReceipt = WorkerPromptOperationIdentity & {
  completedAt: number
  semanticBaseline: WorkerPromptSemanticBaseline
  semanticObservedAt?: number
}

export type WorkerPromptOperationInspection =
  | { verdict: 'not_started' | 'conflict' | 'unverifiable' }
  | { verdict: 'completed'; receipt: WorkerPromptOperationReceipt }
