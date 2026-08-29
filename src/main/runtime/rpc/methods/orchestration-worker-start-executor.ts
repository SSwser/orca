import { randomUUID } from 'node:crypto'
import type { OrchestrationDb } from '../../orchestration/db'
import type { DispatchContextRow, TaskRow, WorkerDispatchRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { activateWorkerGeneration } from './orchestration-worker-start-activation'
import {
  acquireWorkerGenerationEffect,
  operationInProgressReceipt,
  type WorkerGenerationEffectReadback as EffectReadback
} from './orchestration-worker-generation-effect'
import { buildWorkerGenerationOperationIdentities } from './orchestration-worker-generation-identity'
import type { PreparedLocalWorkerStart } from './orchestration-worker-start-preparation'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import {
  createWorkerWorktree,
  EXISTING_WORKTREE_SETUP_RECEIPT,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'

export async function executeAcceptedLocalWorkerStart(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: TaskRow
  started: { dispatch: DispatchContextRow; worker: WorkerDispatchRow }
  prepared: PreparedLocalWorkerStart
}): Promise<unknown> {
  const { runtime, db, runId, task, started, prepared } = args
  if (db.getWorkerDispatch(started.dispatch.id)?.state === 'start_unknown') {
    db.resumeWorkerStartUnknown(started.dispatch.id)
  }
  const { params, requestedWorktree, creationWorktree, launch } = prepared
  const runtimeEpoch = runtime.getRuntimeId()
  const claimantId = `${runtimeEpoch}:${randomUUID()}`
  const operations = buildWorkerGenerationOperationIdentities({
    dispatchId: started.dispatch.id,
    startOptions: prepared.startOptions
  })
  let resolvedWorktree = prepared.resolvedWorktree
  const effects: WorkerEffect[] = []
  if (resolvedWorktree) {
    effects.push(
      { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
  }
  let failedStage = 'execution_start'
  let setupReceipt: WorkerSetupReceipt = EXISTING_WORKTREE_SETUP_RECEIPT
  try {
    if (creationWorktree) {
      const repoSelector = params.repo ?? creationWorktree.repoId
      const inspectWorktree = async (): Promise<EffectReadback> => {
        const readback = await runtime.inspectManagedWorkerGenerationOperation({
          repoSelector,
          ...operations.worktree
        })
        if (readback.verdict !== 'completed') {
          return readback
        }
        const setup = readback.receipt?.setup
        if (!setup) {
          return { verdict: 'unverifiable' }
        }
        return {
          verdict: 'completed',
          receipt: {
            ...readback.receipt,
            setup: {
              ...setup,
              effective: setup.requested,
              source: params.setup ? 'explicit_request' : 'orchestration_default'
            }
          }
        }
      }
      const worktreeOperation = await acquireWorkerGenerationEffect({
        db,
        dispatchId: started.dispatch.id,
        effectKind: 'worktree',
        identity: operations.worktree,
        runtimeEpoch,
        claimantId,
        inspect: inspectWorktree
      })
      if (
        worktreeOperation.disposition === 'in_progress' ||
        worktreeOperation.disposition === 'observe'
      ) {
        return operationInProgressReceipt({
          db,
          runId,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          effectKind: 'worktree',
          effects
        })
      }
      if (worktreeOperation.disposition === 'execute') {
        failedStage = 'worktree_create'
        const created = await createWorkerWorktree({
          runtime,
          db,
          dispatchId: started.dispatch.id,
          requestedWorktree,
          coordinatorWorktree: creationWorktree,
          params,
          operations,
          effects
        })
        resolvedWorktree = created.worktree
        setupReceipt = created.setupReceipt
        db.completeWorkerGenerationOperation({
          dispatchId: started.dispatch.id,
          effectKind: 'worktree',
          ...operations.worktree,
          claimantId,
          receipt: {
            worktreeId: created.worktree.id,
            instanceId: created.worktree.instanceId ?? null,
            setup: created.setupReceipt
          }
        })
      } else if (worktreeOperation.disposition === 'completed') {
        const receipt = worktreeOperation.receipt as {
          worktreeId: string
          setup: WorkerSetupReceipt
        }
        resolvedWorktree = await runtime.showManagedWorktree(`id:${receipt.worktreeId}`)
        setupReceipt = receipt.setup
        effects.push({ kind: 'worktree', action: 'replayed', id: resolvedWorktree.id })
      } else {
        return operationInProgressReceipt({
          db,
          runId,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          effectKind: 'worktree',
          effects
        })
      }
    }
    if (!resolvedWorktree) {
      throw new Error('Worker topology did not resolve a workspace.')
    }
    return await activateWorkerGeneration({
      runtime,
      db,
      runId,
      task,
      dispatch: started.dispatch,
      params,
      operations,
      runtimeEpoch,
      claimantId,
      resolvedWorktree,
      setupReceipt,
      effects,
      launchReceipt: launch.receipt,
      launchPreferences: launch.preferences,
      setFailedStage: (stage) => {
        failedStage = stage
      }
    })
  } catch (error) {
    return failWorkerStartWithReceipt({
      db,
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: setupReceipt,
      launch: launch.receipt
    })
  }
}
