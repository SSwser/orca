import type { OrchestrationDb } from './orchestration/db'

export function prepareContainedWorkerTerminal(args: {
  db: OrchestrationDb
  handle: string
  paneKey: string
  worktreeId: string
}): void {
  const { db, handle, paneKey, worktreeId } = args
  const coordinatorPaneKey = 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const run = db.createRun({
    objective: 'contain terminal custody',
    coordinatorHandle: 'term-coordinator',
    coordinatorPaneKey
  })
  const task = db.createTask({ spec: 'contain exact worker terminal', runId: run.id })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation: 'contained-process',
    hostScope: JSON.stringify({
      kind: 'local',
      hostId: 'local',
      restartCustody: {
        kind: 'windows_daemon_job',
        daemonPid: 4000,
        daemonStartedAtMs: 1_786_000_000_000,
        daemonLaunchNonce: 'terminal-close-continuity'
      }
    }),
    worktreeId,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  db.settleWorkerReport({
    taskId: task.id,
    dispatchId: started.dispatch.id,
    outcome: 'succeeded',
    result: 'archived result'
  })
  const resource = db.getWorkerTerminalResourceByOwner(started.dispatch.id)!
  db.storeWorkerTerminalArchive({
    dispatchId: started.dispatch.id,
    resourceId: resource.id,
    kind: 'terminal_tail',
    content: '{"lines":["archived result"]}'
  })
  db.requestWorkerTerminalRelease(started.dispatch.id)
  db.markWorkerTerminalReleaseUnknown(resource.id, 'lost daemon custody')
  db.insertMessage({
    from: handle,
    to: `run:${run.id}`,
    subject: 'worker done',
    type: 'worker_done',
    runId: run.id,
    payload: JSON.stringify({ taskId: task.id, dispatchId: started.dispatch.id })
  })
  const delivery = db.getOrCreateRunDelivery({
    runId: run.id,
    consumerGeneration: run.consumer_generation
  })!.delivery
  db.acceptLostCustodyWorkerRecovery({
    runId: run.id,
    consumerGeneration: run.consumer_generation,
    coordinatorHandle: 'term-coordinator',
    coordinatorPaneKey,
    sourceDispatchId: started.dispatch.id,
    sourceResourceId: resource.id,
    sourceDeliveryId: delivery.id,
    recoveryDisposition: 'accept_archived_result',
    authorization: 'accept_authoritative_archived_result_with_lost_custody',
    mutationReceipt: {
      callerFingerprint: 'terminal-close-continuity',
      requestId: 'contain-terminal',
      method: 'orchestration.workerRecover',
      payloadHash: 'contain-terminal-hash'
    }
  })
}
