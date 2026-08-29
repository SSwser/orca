import { createHash, randomBytes } from 'node:crypto'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import { generateId } from '../../orchestration/db/generated-id'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { TaskRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildWorkerGenerationOperationIdentities } from './orchestration-worker-generation-identity'

export function prepareWorkerExecutionAdmission(args: {
  runtime: OrcaRuntimeService
  task: Pick<TaskRow, 'id' | 'spec'>
  coordinatorHandle: string
  startOptions: Record<string, unknown>
  launchPreferences?: AgentLaunchPreferences
  devMode?: boolean
  identity?: { dispatchId: string; provisionalCapability: string }
}): {
  dispatchId: string
  provisionalCapability: string
  launchTokenHash: string
  startOptions: Record<string, unknown>
} {
  const dispatchId = args.identity?.dispatchId ?? generateId('ctx')
  const provisionalCapability =
    args.identity?.provisionalCapability ?? `dcap_${randomBytes(32).toString('base64url')}`
  const operations = buildWorkerGenerationOperationIdentities({
    dispatchId,
    startOptions: args.startOptions
  })
  const prompt = buildDispatchPreamble({
    taskId: args.task.id,
    dispatchId,
    taskSpec: args.task.spec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: operations.executionStart.terminalHandle,
    dispatchCapability: provisionalCapability,
    devMode: args.devMode,
    cliCommand: args.runtime.getTerminalOrchestrationCliCommand(
      operations.executionStart.terminalHandle
    )
  })
  const admission = args.runtime.resolveWorkerAgentProcessAdmission({
    prompt,
    launchPreferences: args.launchPreferences
  })
  const launchTokenHash = createHash('sha256')
    .update(args.runtime.deriveWorkerAgentLaunchToken(provisionalCapability))
    .digest('hex')
  return {
    dispatchId,
    provisionalCapability,
    launchTokenHash,
    startOptions: {
      ...args.startOptions,
      executionTargetFingerprint: admission.targetFingerprint
    }
  }
}
