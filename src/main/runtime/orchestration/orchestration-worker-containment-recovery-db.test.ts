import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'

const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'
const WORKER_PANE = 'tab_worker:22222222-2222-4222-8222-222222222222'
const TRUSTED_REVISION = '0123456789abcdef0123456789abcdef01234567'
const LOCAL_RESTART_SCOPE = JSON.stringify({
  kind: 'local',
  hostId: 'local',
  restartCustody: {
    kind: 'windows_daemon_job',
    daemonPid: 8100,
    daemonStartedAtMs: 1_786_000_000_000,
    daemonLaunchNonce: 'source-recovery-daemon'
  }
})

describe('lost-custody worker containment recovery', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createFixture(database = new OrchestrationDb(':memory:')) {
    db = database
    const run = db.createRun({
      objective: 'recover contained worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE
    })
    const task = db.createTask({ spec: 'produce a durable result', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { worktree: 'current', resolvedWorktreeId: 'repo::generation-1' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'daemon-1:pty-1:process-1',
      hostScope: LOCAL_RESTART_SCOPE,
      worktreeId: 'repo::generation-1',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: 'archived result'
      })
    ).toMatchObject({ action: 'settled' })
    const resource = db.getWorkerTerminalResourceByOwner(started.dispatch.id)!
    db.storeWorkerTerminalArchive({
      dispatchId: started.dispatch.id,
      resourceId: resource.id,
      kind: 'terminal_tail',
      content: '{"lines":["archived result"]}'
    })
    expect(db.requestWorkerTerminalRelease(started.dispatch.id).disposition).toBe('requested')
    db.markWorkerTerminalReleaseUnknown(resource.id, 'daemon custody was lost')
    const message = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'worker done',
      type: 'worker_done',
      runId: run.id,
      payload: JSON.stringify({ taskId: task.id, dispatchId: started.dispatch.id })
    })
    const delivery = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!
    return { run, task, source: started, resource, message, delivery }
  }

  function recoveryParams(fixture: ReturnType<typeof createFixture>, requestId = 'recover-1') {
    return {
      runId: fixture.run.id,
      consumerGeneration: fixture.run.consumer_generation,
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE,
      sourceDispatchId: fixture.source.dispatch.id,
      sourceResourceId: fixture.resource.id,
      sourceDeliveryId: fixture.delivery.delivery.id,
      recoveryDisposition: 'retry_with_successor' as const,
      trustedRevision: TRUSTED_REVISION,
      successorPlacement: 'new-child' as const,
      successorName: 'recovered-generation-2',
      authorization: 'acknowledge_possible_duplicate_external_effects' as const,
      successorDispatchId: `ctx_successor_${requestId}`,
      provisionalCapability: `dcap_successor_${requestId}`,
      launchTokenHash: 'a'.repeat(64),
      startOptions: {
        worktree: 'new-child',
        name: 'recovered-generation-2',
        trustedRevision: TRUSTED_REVISION,
        recoveryOf: fixture.source.dispatch.id
      },
      mutationReceipt: {
        callerFingerprint: 'caller-1',
        requestId,
        method: 'orchestration.workerRecover',
        payloadHash: `hash-${requestId}`
      }
    }
  }

  it('accepts an authoritative archive without creating a successor', () => {
    const fixture = createFixture()
    const dependent = db!.createTask({
      spec: 'wait for authoritative archive finalization',
      runId: fixture.run.id,
      deps: [fixture.task.id]
    })
    const {
      trustedRevision: _trustedRevision,
      successorPlacement: _successorPlacement,
      successorName: _successorName,
      startOptions: _startOptions,
      successorDispatchId: _successorDispatchId,
      provisionalCapability: _provisionalCapability,
      launchTokenHash: _launchTokenHash,
      authorization: _authorization,
      ...base
    } = recoveryParams(fixture, 'accept-archive')
    const accepted = db!.acceptLostCustodyWorkerRecovery({
      ...base,
      recoveryDisposition: 'accept_archived_result',
      authorization: 'accept_authoritative_archived_result_with_lost_custody'
    })
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(accepted).toMatchObject({
      disposition: 'accepted',
      processAction: 'none',
      recovery: { disposition: 'accept_archived_result' },
      successor: null
    })
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM dispatch_contexts WHERE task_id = ?')
        .get(fixture.task.id)
    ).toEqual({ count: 1 })
    expect(db!.getWorkerTerminalArchive(fixture.source.dispatch.id)?.content).toBe(
      '{"lines":["archived result"]}'
    )
    expect(db!.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe('contained')
    expect(db!.getDeliveryRaw(fixture.delivery.delivery.id)).toMatchObject({
      status: 'contained',
      acknowledged_at: null
    })
    expect(db!.getTask(fixture.task.id)).toMatchObject({
      status: 'completed',
      result: 'archived result'
    })
    expect(db!.getTask(dependent.id)?.status).toBe('ready')
  })

  it('atomically contains the source, resolves its Delivery, withholds capacity, and accepts one successor', () => {
    const fixture = createFixture()
    const accepted = db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(accepted).toMatchObject({
      disposition: 'accepted',
      processAction: 'none',
      recovery: {
        source_dispatch_id: fixture.source.dispatch.id,
        source_resource_id: fixture.resource.id,
        source_delivery_id: fixture.delivery.delivery.id,
        source_worktree_id: 'repo::generation-1',
        trusted_revision: TRUSTED_REVISION,
        authorization: 'acknowledge_possible_duplicate_external_effects'
      },
      successor: { worker: { state: 'starting', stage: 'accepted' } }
    })
    expect(accepted.recovery.successor_dispatch_id).toBe(accepted.successor.dispatch.id)
    expect(db!.getWorkerTerminalResource(fixture.resource.id)).toMatchObject({
      lifecycle_state: 'contained',
      retained_reason: 'lost_custody',
      release_error: 'daemon custody was lost',
      process_incarnation: 'daemon-1:pty-1:process-1'
    })
    expect(db!.getWorkerTerminalArchive(fixture.source.dispatch.id)?.content).toBe(
      '{"lines":["archived result"]}'
    )
    expect(db!.getDeliveryRaw(fixture.delivery.delivery.id)).toMatchObject({
      status: 'contained',
      acknowledged_at: null
    })
    expect(db!.getMessageById(fixture.message.id)?.read).toBe(1)
    expect(db!.getTask(fixture.task.id)).toMatchObject({
      status: 'dispatched',
      result: null,
      completed_at: null
    })
    expect(db!.getDispatchContext(fixture.task.id)?.id).toBe(
      accepted.recovery.successor_dispatch_id
    )
    expect(
      sqlite
        .prepare('SELECT worktree_id, source_resource_id FROM worker_workspace_generation_fences')
        .get()
    ).toEqual({
      worktree_id: 'repo::generation-1',
      source_resource_id: fixture.resource.id
    })
    expect(
      sqlite.prepare('SELECT resource_id, state FROM worker_execution_capacity_debts').get()
    ).toEqual({ resource_id: fixture.resource.id, state: 'withheld' })
    expect(() =>
      db!.acknowledgeRunDelivery({
        runId: fixture.run.id,
        consumerGeneration: fixture.run.consumer_generation,
        deliveryId: fixture.delivery.delivery.id
      })
    ).toThrow(/permanently resolved by worker containment/i)
    expect(db!.getDeliveryRaw(fixture.delivery.delivery.id)).toMatchObject({
      status: 'contained',
      acknowledged_at: null
    })
  })

  it('replays the same durable receipt without another successor or Delivery mutation', () => {
    const fixture = createFixture()
    const params = recoveryParams(fixture)
    const first = db!.acceptLostCustodyWorkerRecovery(params)
    const replay = db!.acceptLostCustodyWorkerRecovery(params)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(replay).toMatchObject({
      disposition: 'replayed',
      processAction: 'none',
      recovery: { successor_dispatch_id: first.recovery.successor_dispatch_id }
    })
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM worker_lost_custody_recoveries').get()
    ).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM dispatch_contexts WHERE task_id = ?')
        .get(fixture.task.id)
    ).toEqual({ count: 2 })
  })

  it('converges independent recovery requests on one accepted successor', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-recovery-concurrency-'))
    const path = join(root, 'orchestration.db')
    const first = new OrchestrationDb(path)
    const fixture = createFixture(first)
    const second = new OrchestrationDb(path)
    try {
      const firstParams = recoveryParams(fixture, 'recover-connection-a')
      const secondParams = {
        ...recoveryParams(fixture, 'recover-connection-b'),
        mutationReceipt: {
          ...recoveryParams(fixture, 'recover-connection-b').mutationReceipt,
          payloadHash: firstParams.mutationReceipt.payloadHash
        }
      }

      const accepted = first.acceptLostCustodyWorkerRecovery(firstParams)
      const replayed = second.acceptLostCustodyWorkerRecovery(secondParams)

      expect(replayed).toMatchObject({
        disposition: 'replayed',
        recovery: { id: accepted.recovery.id },
        successor: { dispatch: { id: accepted.successor.dispatch.id } }
      })
      expect(
        second.db.prepare('SELECT COUNT(*) AS count FROM worker_lost_custody_recoveries').get()
      ).toEqual({ count: 1 })
      expect(
        second.db
          .prepare('SELECT COUNT(*) AS count FROM dispatch_contexts WHERE task_id = ?')
          .get(fixture.task.id)
      ).toEqual({ count: 2 })
    } finally {
      second.close()
      db = undefined
      first.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects missing authorization and stale consumer authority without changing state', () => {
    const fixture = createFixture()
    const missingAuthorization = {
      ...recoveryParams(fixture, 'missing-auth'),
      authorization: 'missing' as never
    }
    expect(() => db!.acceptLostCustodyWorkerRecovery(missingAuthorization)).toThrow(
      /explicit authorization.*lost-custody disposition/i
    )
    const staleConsumer = {
      ...recoveryParams(fixture, 'stale-consumer'),
      consumerGeneration: fixture.run.consumer_generation + 1
    }
    expect(() => db!.acceptLostCustodyWorkerRecovery(staleConsumer)).toThrowError(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    expect(db!.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe(
      'release_unknown'
    )
    expect(db!.getDeliveryRaw(fixture.delivery.delivery.id)?.status).toBe('outstanding')
    expect(db!.getTask(fixture.task.id)?.status).toBe('dispatched')
  })

  it('fails closed without local execution-host restart custody', () => {
    const fixture = createFixture()
    db!.db
      .prepare('UPDATE worker_execution_resources SET host_scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'ssh-worker-host' }), fixture.resource.id)

    expect(() => db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))).toThrowError(
      expect.objectContaining({ code: 'federation_unsupported' })
    )
    expect(db!.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe(
      'release_unknown'
    )
  })

  it('fails closed for a paired or federated source dispatch', () => {
    const fixture = createFixture()
    db!.db
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(fixture.source.dispatch.id, 'environment-1', 'paired host', 'peer-1', 1)

    expect(() => db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))).toThrowError(
      expect.objectContaining({ code: 'federation_unsupported' })
    )
    expect(db!.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe(
      'release_unknown'
    )
  })

  it('rolls every boundary back when successor acceptance fails', () => {
    const fixture = createFixture()
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite.exec(`
      CREATE TRIGGER reject_recovery_successor
      BEFORE INSERT ON worker_dispatches
      WHEN NEW.dispatch_id != '${fixture.source.dispatch.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected successor failure');
      END;
    `)

    expect(() => db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))).toThrow(
      /injected successor failure/
    )
    expect(db!.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe(
      'release_unknown'
    )
    expect(db!.getDeliveryRaw(fixture.delivery.delivery.id)?.status).toBe('outstanding')
    expect(db!.getMessageById(fixture.message.id)?.read).toBe(0)
    expect(db!.getTask(fixture.task.id)?.status).toBe('dispatched')
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM worker_lost_custody_recoveries').get()
    ).toEqual({ count: 0 })
  })

  it('returns contained capacity only after the exact recorded process exits', () => {
    const fixture = createFixture()
    db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))

    expect(
      db!.settleContainedWorkerTerminalExit({
        resourceId: fixture.resource.id,
        sourceDispatchId: fixture.source.dispatch.id,
        processIncarnation: 'changed-process',
        hostScope: LOCAL_RESTART_SCOPE
      })
    ).toMatchObject({ disposition: 'retained', processAction: 'none' })
    expect(db!.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe('contained')

    const settled = db!.settleContainedWorkerTerminalExit({
      resourceId: fixture.resource.id,
      sourceDispatchId: fixture.source.dispatch.id,
      processIncarnation: 'daemon-1:pty-1:process-1',
      hostScope: LOCAL_RESTART_SCOPE
    })
    expect(settled).toMatchObject({ disposition: 'released', processAction: 'none' })
    expect(db!.getWorkerTerminalResource(fixture.resource.id)?.lifecycle_state).toBe('released')
    const sqlite = (db as unknown as { db: Database.Database }).db
    expect(
      sqlite
        .prepare(
          'SELECT state, released_at IS NOT NULL AS released FROM worker_execution_capacity_debts'
        )
        .get()
    ).toEqual({ state: 'released', released: 1 })
    expect(
      db!.settleContainedWorkerTerminalExit({
        resourceId: fixture.resource.id,
        sourceDispatchId: fixture.source.dispatch.id,
        processIncarnation: 'daemon-1:pty-1:process-1',
        hostScope: LOCAL_RESTART_SCOPE
      })
    ).toMatchObject({ disposition: 'already_released', processAction: 'none' })
    expect(() =>
      db!.acknowledgeRunDelivery({
        runId: fixture.run.id,
        consumerGeneration: fixture.run.consumer_generation,
        deliveryId: fixture.delivery.delivery.id
      })
    ).toThrow(/permanently resolved by worker containment/i)
    expect(db!.getDeliveryRaw(fixture.delivery.delivery.id)).toMatchObject({
      status: 'contained',
      acknowledged_at: null
    })
  })

  it('rejects direct containment of an owned failed successor', () => {
    const fixture = createFixture()
    const first = db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))
    const successor = first.successor
    db!.prepareStartingWorkerAuthority({
      dispatchId: successor.dispatch.id,
      handle: 'term_successor',
      paneKey: 'tab_worker:44444444-4444-4444-8444-444444444444',
      processIncarnation: 'daemon-2:pty-2:process-2',
      hostScope: JSON.stringify({
        kind: 'local',
        hostId: 'local',
        restartCustody: {
          kind: 'windows_daemon_job',
          daemonPid: 9000,
          daemonStartedAtMs: 1_786_000_000_000,
          daemonLaunchNonce: 'test-daemon'
        }
      }),
      worktreeId: 'repo::generation-2',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db!.db
      .prepare(
        `UPDATE worker_dispatches SET state = 'abandoned', stage = 'terminal_missing' WHERE dispatch_id = ?`
      )
      .run(successor.dispatch.id)
    db!.db
      .prepare(`UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?`)
      .run(successor.dispatch.id)
    const successorResource = db!.getWorkerTerminalResourceByOwner(successor.dispatch.id)!
    db!.storeWorkerTerminalArchive({
      dispatchId: successor.dispatch.id,
      resourceId: successorResource.id,
      kind: 'terminal_tail',
      content: '{"lines":["successor output"]}'
    })
    const successorMessage = db!.insertMessage({
      from: 'term_successor',
      to: `run:${fixture.run.id}`,
      subject: 'successor done',
      type: 'worker_done',
      runId: fixture.run.id,
      payload: JSON.stringify({ taskId: fixture.task.id, dispatchId: successor.dispatch.id })
    })
    const successorDelivery = db!.getOrCreateRunDelivery({
      runId: fixture.run.id,
      consumerGeneration: fixture.run.consumer_generation
    })!

    expect(() =>
      db!.acceptLostCustodyWorkerRecovery({
        ...recoveryParams(fixture, 'recover-generation-3'),
        sourceDispatchId: successor.dispatch.id,
        sourceResourceId: successorResource.id,
        sourceDeliveryId: successorDelivery.delivery.id,
        successorName: 'recovered-generation-3',
        startOptions: { worktree: 'new-child', recoveryOf: successor.dispatch.id }
      })
    ).toThrow(/release_unknown/i)
    expect(db!.getWorkerTerminalResource(successorResource.id)?.lifecycle_state).toBe('owned')
    expect(db!.getWorkerTerminalArchive(successor.dispatch.id)?.content).toBe(
      '{"lines":["successor output"]}'
    )
    expect(db!.getDeliveryRaw(successorDelivery.delivery.id)?.status).toBe('outstanding')
    expect(successorMessage).toBeDefined()
    expect(
      db!.db.prepare('SELECT COUNT(*) AS count FROM worker_lost_custody_recoveries').get()
    ).toEqual({ count: 1 })
  })

  it('fails closed for an unverifiable failed successor without restart custody', () => {
    const fixture = createFixture()
    const first = db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))
    const successor = first.successor
    db!.prepareStartingWorkerAuthority({
      dispatchId: successor.dispatch.id,
      handle: 'term_successor',
      paneKey: 'tab_worker:55555555-5555-4555-8555-555555555555',
      processIncarnation: 'ssh-daemon:pty:process',
      hostScope: JSON.stringify({ kind: 'ssh', targetId: 'ssh-1' }),
      worktreeId: 'repo::generation-2',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db!.db
      .prepare(
        `UPDATE worker_dispatches SET state = 'abandoned', stage = 'terminal_missing' WHERE dispatch_id = ?`
      )
      .run(successor.dispatch.id)
    db!.db
      .prepare(`UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?`)
      .run(successor.dispatch.id)
    const resource = db!.getWorkerTerminalResourceByOwner(successor.dispatch.id)!
    db!.insertMessage({
      from: 'term_successor',
      to: `run:${fixture.run.id}`,
      subject: 'successor done',
      type: 'worker_done',
      runId: fixture.run.id,
      payload: JSON.stringify({ taskId: fixture.task.id, dispatchId: successor.dispatch.id })
    })
    const delivery = db!.getOrCreateRunDelivery({
      runId: fixture.run.id,
      consumerGeneration: fixture.run.consumer_generation
    })!
    expect(() =>
      db!.acceptLostCustodyWorkerRecovery({
        ...recoveryParams(fixture, 'ssh-recovery'),
        sourceDispatchId: successor.dispatch.id,
        sourceResourceId: resource.id,
        sourceDeliveryId: delivery.delivery.id
      })
    ).toThrow(/release_unknown/i)
  })

  it('rebinds the Run and delivers only the successor completion before normal ACK', () => {
    const fixture = createFixture()
    const dependent = db!.createTask({
      spec: 'wait for final successor settlement',
      runId: fixture.run.id,
      deps: [fixture.task.id]
    })
    const accepted = db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))
    const rebound = db!.bindRun({
      runId: fixture.run.id,
      coordinatorHandle: 'term_coord_restarted',
      coordinatorPaneKey: 'tab_coord:33333333-3333-4333-8333-333333333333'
    })!
    expect(
      db!.getOrCreateRunDelivery({
        runId: fixture.run.id,
        consumerGeneration: rebound.consumer_generation
      })
    ).toBeUndefined()

    db!.prepareStartingWorkerAuthority({
      dispatchId: accepted.successor.dispatch.id,
      handle: 'term_successor',
      paneKey: 'tab_worker:44444444-4444-4444-8444-444444444444',
      processIncarnation: 'daemon-2:pty-2:process-2',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      worktreeId: 'repo::generation-2',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db!.markWorkerDispatchReady(accepted.successor.dispatch.id)
    db!.settleWorkerReport({
      taskId: fixture.task.id,
      dispatchId: accepted.successor.dispatch.id,
      outcome: 'succeeded',
      result: 'successor result'
    })
    const successorDone = db!.insertMessage({
      from: 'term_successor',
      to: `run:${fixture.run.id}`,
      subject: 'successor done',
      type: 'worker_done',
      runId: fixture.run.id,
      payload: JSON.stringify({
        taskId: fixture.task.id,
        dispatchId: accepted.successor.dispatch.id
      })
    })
    const successorDelivery = db!.getOrCreateRunDelivery({
      runId: fixture.run.id,
      consumerGeneration: rebound.consumer_generation
    })!
    expect(successorDelivery.messages.map((message) => message.id)).toEqual([successorDone.id])
    expect(() =>
      db!.acknowledgeRunDelivery({
        runId: fixture.run.id,
        consumerGeneration: rebound.consumer_generation,
        deliveryId: successorDelivery.delivery.id
      })
    ).toThrow(/unsettled worker terminal resource/i)
    expect(db!.getTask(fixture.task.id)?.status).toBe('dispatched')
    expect(db!.getTask(dependent.id)?.status).toBe('pending')

    const successorResource = db!.getWorkerTerminalResourceByOwner(accepted.successor.dispatch.id)!
    expect(db!.requestWorkerTerminalRelease(accepted.successor.dispatch.id).disposition).toBe(
      'requested'
    )
    db!.settleWorkerTerminalRelease(successorResource.id)
    expect(
      db!.acknowledgeRunDelivery({
        runId: fixture.run.id,
        consumerGeneration: rebound.consumer_generation,
        deliveryId: successorDelivery.delivery.id
      })
    ).toMatchObject({ duplicate: false, delivery: { status: 'acknowledged' } })
    expect(db!.getDeliveryRaw(fixture.delivery.delivery.id)?.status).toBe('contained')
    expect(db!.getTask(fixture.task.id)).toMatchObject({
      status: 'completed',
      result: 'successor result'
    })
    expect(db!.getTask(dependent.id)?.status).toBe('ready')
  })

  it('keeps late worker_done from the contained source audit-only after successor acceptance', () => {
    const fixture = createFixture()
    const accepted = db!.acceptLostCustodyWorkerRecovery(recoveryParams(fixture))
    const late = db!.insertMessage({
      from: 'term_worker',
      to: `run:${fixture.run.id}`,
      subject: 'late source completion',
      type: 'worker_done',
      runId: fixture.run.id,
      payload: JSON.stringify({
        taskId: fixture.task.id,
        dispatchId: fixture.source.dispatch.id,
        outcome: 'succeeded'
      }),
      senderPaneKey: WORKER_PANE
    })

    expect(reconcileLifecycleMessage(db!, late)).toMatchObject({
      action: 'rejected',
      code: 'inactive_dispatch'
    })
    expect(db!.getMessageById(late.id)).toMatchObject({ read: 1 })
    expect(
      db!.getOrCreateRunDelivery({
        runId: fixture.run.id,
        consumerGeneration: fixture.run.consumer_generation
      })
    ).toBeUndefined()
    expect(db!.getDispatchContext(fixture.task.id)?.id).toBe(accepted.successor.dispatch.id)
    expect(db!.getWorkerDispatch(accepted.successor.dispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'accepted'
    })
    expect(db!.getTask(fixture.task.id)?.status).toBe('dispatched')
  })
})
