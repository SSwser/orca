import type { IPtyProvider } from '../providers/types'

export function supports(owner: IPtyProvider, id: string): boolean {
  return owner.supportsWorkerPromptOperations?.(id) === true
}

export async function write(
  owner: IPtyProvider,
  id: string,
  operation: Parameters<NonNullable<IPtyProvider['writeWorkerPromptOperation']>>[1]
): Promise<{ accepted: boolean }> {
  if (!owner.writeWorkerPromptOperation || !supports(owner, id)) {
    throw new Error('worker_prompt_operation_unsupported')
  }
  return await owner.writeWorkerPromptOperation(id, operation)
}

export async function inspect(
  owner: IPtyProvider,
  id: string,
  identity: Parameters<NonNullable<IPtyProvider['inspectWorkerPromptOperation']>>[1]
): ReturnType<NonNullable<IPtyProvider['inspectWorkerPromptOperation']>> {
  if (!owner.inspectWorkerPromptOperation || !supports(owner, id)) {
    return { verdict: 'unverifiable' }
  }
  return await owner.inspectWorkerPromptOperation(id, identity)
}
