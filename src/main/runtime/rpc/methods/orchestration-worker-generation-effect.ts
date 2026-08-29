import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerEffect } from './orchestration-worker-topology'
import type { WorkerGenerationOperationIdentity } from './orchestration-worker-generation-identity'

export type WorkerGenerationEffectKind = 'worktree' | 'execution_start'
export type WorkerGenerationEffectReadback =
  | { verdict: 'not_started' | 'conflict' | 'unverifiable' }
  | { verdict: 'started' }
  | { verdict: 'accepted'; receipt: unknown }
  | { verdict: 'completed'; receipt: unknown }

export async function acquireWorkerGenerationEffect(args: {
  db: OrchestrationDb
  dispatchId: string
  effectKind: WorkerGenerationEffectKind
  identity: WorkerGenerationOperationIdentity
  runtimeEpoch: string
  claimantId: string
  inspect: () => Promise<WorkerGenerationEffectReadback>
}): Promise<
  | { disposition: 'execute' | 'observe' | 'in_progress' }
  | { disposition: 'completed'; receipt: unknown }
> {
  const claim = args.db.claimWorkerGenerationOperation({
    dispatchId: args.dispatchId,
    effectKind: args.effectKind,
    ...args.identity,
    claimantId: args.claimantId
  })
  if (claim.claimed) {
    return { disposition: 'execute' }
  }
  if (claim.verdict === 'completed') {
    return { disposition: 'completed', receipt: claim.receipt }
  }
  if (claim.verdict === 'conflict') {
    throw new OrchestrationError(
      'request_mismatch',
      `Worker generation ${args.effectKind} operation identity conflicts with its durable claim.`
    )
  }
  if (claim.state === 'claimed' && claim.claimantId?.startsWith(`${args.runtimeEpoch}:`)) {
    return { disposition: 'in_progress' }
  }
  let readback: WorkerGenerationEffectReadback
  try {
    readback = await args.inspect()
  } catch (error) {
    if (
      claim.claimantId &&
      error &&
      typeof error === 'object' &&
      (error as { agentSessionOperationOutcome?: unknown }).agentSessionOperationOutcome ===
        'unknown'
    ) {
      args.db.markWorkerGenerationOperationUnverifiable({
        dispatchId: args.dispatchId,
        effectKind: args.effectKind,
        ...args.identity,
        claimantId: claim.claimantId
      })
    }
    throw error
  }
  if (readback.verdict === 'conflict') {
    throw new OrchestrationError(
      'request_mismatch',
      `Worker generation ${args.effectKind} owner reported an identity conflict.`
    )
  }
  if (readback.verdict === 'unverifiable') {
    if (claim.claimantId) {
      args.db.markWorkerGenerationOperationUnverifiable({
        dispatchId: args.dispatchId,
        effectKind: args.effectKind,
        ...args.identity,
        claimantId: claim.claimantId
      })
    }
    return { disposition: 'in_progress' }
  }
  if (!claim.claimantId) {
    return { disposition: 'in_progress' }
  }
  const reclaimed = args.db.reclaimWorkerGenerationOperation({
    dispatchId: args.dispatchId,
    effectKind: args.effectKind,
    ...args.identity,
    expectedClaimantId: claim.claimantId,
    claimantId: args.claimantId
  })
  if (!reclaimed) {
    return { disposition: 'in_progress' }
  }
  if (readback.verdict === 'not_started') {
    return { disposition: 'execute' }
  }
  if (readback.verdict === 'started') {
    return { disposition: 'observe' }
  }
  if (readback.verdict !== 'completed' && readback.verdict !== 'accepted') {
    return { disposition: 'in_progress' }
  }
  args.db.completeWorkerGenerationOperation({
    dispatchId: args.dispatchId,
    effectKind: args.effectKind,
    ...args.identity,
    claimantId: args.claimantId,
    receipt: readback.receipt
  })
  return { disposition: 'completed', receipt: readback.receipt }
}

export function operationInProgressReceipt(args: {
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  effectKind: string
  effects: WorkerEffect[]
}) {
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state:
      args.db.getWorkerDispatch(args.dispatchId)?.state === 'start_unknown'
        ? 'outcome_unknown'
        : 'starting',
    stage: `${args.effectKind}_operation_in_progress`,
    effects: args.effects,
    residualResources: [],
    processAction: 'none' as const
  }
}
