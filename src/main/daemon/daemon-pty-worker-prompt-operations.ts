import type {
  WorkerPromptOperationIdentity,
  WorkerPromptOperationInspection,
  WorkerPromptOperationRequest
} from '../../shared/worker-prompt-operation'
import { DaemonPtySessionSpawn } from './daemon-pty-session-spawn'

export abstract class DaemonPtyWorkerPromptOperations extends DaemonPtySessionSpawn {
  async writeWorkerPromptOperation(
    id: string,
    operation: WorkerPromptOperationRequest
  ): Promise<{ accepted: boolean }> {
    if (!this.supportsWorkerPromptOperations()) {
      throw new Error('worker_prompt_operation_unsupported')
    }
    await this.ensureConnected()
    return await this.client.request('writeWorkerPromptOperation', {
      sessionId: id,
      ...operation
    })
  }

  async inspectWorkerPromptOperation(
    id: string,
    identity: WorkerPromptOperationIdentity
  ): Promise<WorkerPromptOperationInspection> {
    if (!this.supportsWorkerPromptOperations()) {
      return { verdict: 'unverifiable' }
    }
    try {
      await this.ensureConnected()
      return await this.client.request('inspectWorkerPromptOperation', {
        sessionId: id,
        ...identity
      })
    } catch {
      return { verdict: 'unverifiable' }
    }
  }
}
