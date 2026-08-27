import type {
  WorkerPromptOperationIdentity,
  WorkerPromptOperationRequest
} from '../../shared/worker-prompt-operation'

export type WriteWorkerPromptOperationRequest = {
  id: string
  type: 'writeWorkerPromptOperation'
  payload: WorkerPromptOperationRequest & { sessionId: string }
}

export type InspectWorkerPromptOperationRequest = {
  id: string
  type: 'inspectWorkerPromptOperation'
  payload: WorkerPromptOperationIdentity & { sessionId: string }
}
