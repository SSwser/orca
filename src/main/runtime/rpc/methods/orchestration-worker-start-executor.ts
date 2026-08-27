import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrchestrationDb } from '../../orchestration/db'
import type { DispatchContextRow, TaskRow, WorkerDispatchRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import { activateWorkerGeneration } from './orchestration-worker-start-activation'
import {
  acquireWorkerGenerationEffect,
  operationInProgressReceipt,
  type WorkerGenerationEffectReadback as EffectReadback
} from './orchestration-worker-generation-effect'
import { buildWorkerGenerationOperationIdentities } from './orchestration-worker-generation-identity'
import type { PreparedLocalWorkerStart } from './orchestration-worker-start-preparation'

type StartedWorker = { dispatch: DispatchContextRow; worker: WorkerDispatchRow }

export async function executeAcceptedLocalWorkerStart(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: TaskRow
  started: StartedWorker
  prepared: PreparedLocalWorkerStart
}): Promise<unknown> {
  const { runtime, db, runId, task, started, prepared } = args
  const { params, requestedWorktree, creationWorktree, agent, launch } = prepared
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
  let terminalHandle = params.terminal
  let terminalOperationNeedsCompletion = false
  let terminalRevealWarning: string | undefined
  let failedStage = 'terminal_create'
  let setupReceipt: WorkerSetupReceipt = {
    requested: 'not_applicable',
    effective: 'not_applicable',
    source: 'existing_worktree',
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: 'not_applicable'
  }
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
      if (worktreeOperation.disposition === 'in_progress') {
        return operationInProgressReceipt({
          db,
          runId,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          effectKind: 'worktree',
          effects
        })
      }
      const inspectTerminal = async (): Promise<EffectReadback> => {
        const worktreeReadback = await runtime.inspectManagedWorkerGenerationOperation({
          repoSelector,
          ...operations.worktree
        })
        if (worktreeReadback.verdict !== 'completed') {
          return worktreeReadback
        }
        if (worktreeReadback.receipt?.terminalHandle !== operations.terminal.terminalHandle) {
          return { verdict: 'conflict' }
        }
        try {
          const terminal = await runtime.showTerminal(operations.terminal.terminalHandle)
          if (terminal.worktreeId !== worktreeReadback.worktree.id) {
            return { verdict: 'conflict' }
          }
          const authority = requireWorkerAuthority(runtime, operations.terminal.terminalHandle, {
            requireNativeWindowsRestartCustody: process.platform === 'win32'
          })
          return {
            verdict: 'completed',
            receipt: {
              terminalHandle: operations.terminal.terminalHandle,
              worktreeId: worktreeReadback.worktree.id,
              ...authority
            }
          }
        } catch {
          return { verdict: 'unverifiable' }
        }
      }
      const terminalOperation = await acquireWorkerGenerationEffect({
        db,
        dispatchId: started.dispatch.id,
        effectKind: 'terminal',
        identity: operations.terminal,
        runtimeEpoch,
        claimantId,
        inspect: inspectTerminal
      })
      if (terminalOperation.disposition === 'in_progress') {
        return operationInProgressReceipt({
          db,
          runId,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          effectKind: 'terminal',
          effects
        })
      }
      terminalOperationNeedsCompletion = terminalOperation.disposition === 'execute'
      if (worktreeOperation.disposition === 'execute') {
        failedStage = 'worktree_create'
        const created = await createWorkerWorktree({
          runtime,
          db,
          dispatchId: started.dispatch.id,
          requestedWorktree,
          coordinatorWorktree: creationWorktree,
          params,
          agent: agent as TuiAgent,
          launchPreferences: launch.preferences,
          operations,
          effects
        })
        resolvedWorktree = created.worktree
        terminalHandle = created.terminalHandle
        setupReceipt = created.setupReceipt
        db.completeWorkerGenerationOperation({
          dispatchId: started.dispatch.id,
          effectKind: 'worktree',
          ...operations.worktree,
          claimantId,
          receipt: {
            worktreeId: created.worktree.id,
            instanceId: created.worktree.instanceId ?? null,
            terminalHandle: created.terminalHandle,
            setup: created.setupReceipt
          }
        })
      } else if (worktreeOperation.disposition === 'completed') {
        const receipt = worktreeOperation.receipt as {
          worktreeId: string
          terminalHandle: string
          setup: WorkerSetupReceipt
        }
        resolvedWorktree = await runtime.showManagedWorktree(`id:${receipt.worktreeId}`)
        terminalHandle = receipt.terminalHandle
        setupReceipt = receipt.setup
        effects.push({ kind: 'worktree', action: 'replayed', id: resolvedWorktree.id })
      }
    } else if (!terminalHandle) {
      const terminalOperation = await acquireWorkerGenerationEffect({
        db,
        dispatchId: started.dispatch.id,
        effectKind: 'terminal',
        identity: operations.terminal,
        runtimeEpoch,
        claimantId,
        inspect: async () => {
          try {
            const terminal = await runtime.showTerminal(operations.terminal.terminalHandle)
            if (terminal.worktreeId !== resolvedWorktree!.id) {
              return { verdict: 'conflict' }
            }
            const authority = requireWorkerAuthority(runtime, operations.terminal.terminalHandle, {
              requireNativeWindowsRestartCustody: process.platform === 'win32'
            })
            return {
              verdict: 'completed',
              receipt: {
                terminalHandle: operations.terminal.terminalHandle,
                worktreeId: resolvedWorktree!.id,
                ...authority
              }
            }
          } catch {
            return { verdict: 'not_started' }
          }
        }
      })
      if (terminalOperation.disposition === 'in_progress') {
        return operationInProgressReceipt({
          db,
          runId,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          effectKind: 'terminal',
          effects
        })
      }
      terminalOperationNeedsCompletion = terminalOperation.disposition === 'execute'
      if (terminalOperation.disposition === 'execute') {
        db.recordWorkerStage({
          dispatchId: started.dispatch.id,
          stage: 'terminal_creating',
          worktreeId: resolvedWorktree!.id,
          effects
        })
        const terminal = await createExistingWorktreeWorkerTerminal({
          runtime,
          worktreeId: resolvedWorktree!.id,
          agent: agent as TuiAgent,
          launchPreferences: launch.preferences,
          taskId: task.id,
          operation: operations.terminal,
          effects
        })
        terminalHandle = terminal.handle
        terminalRevealWarning = terminal.warning
      } else if (terminalOperation.disposition === 'completed') {
        terminalHandle = (terminalOperation.receipt as { terminalHandle: string }).terminalHandle
        effects.push({ kind: 'terminal', role: 'agent', action: 'replayed', id: terminalHandle })
      }
    } else {
      effects.push({ kind: 'terminal', role: 'agent', action: 'reused', id: terminalHandle })
    }
    if (!resolvedWorktree || !terminalHandle) {
      throw new Error('Worker topology did not resolve an agent terminal and worktree.')
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
      terminalHandle,
      terminalOperationNeedsCompletion,
      setupReceipt,
      effects,
      launchReceipt: launch.receipt,
      terminalRevealWarning,
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
