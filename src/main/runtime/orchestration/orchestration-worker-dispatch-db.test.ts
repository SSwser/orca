import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_CONTRACT_VERSION, OrchestrationDb } from './db'

describe('OrchestrationDb worker Dispatch state', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('creates and activates a composed worker Dispatch transactionally', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'worker' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    expect(started).toMatchObject({
      dispatch: { status: 'pending' },
      worker: { state: 'starting', stage: 'accepted' }
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')

    const capability = d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }]
    })
    expect(capability).toMatch(/^dcap_/)
    expect(d.markWorkerDispatchReady(started.dispatch.id)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'dispatched',
      assignee_handle: 'term_worker'
    })
    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([
      expect.objectContaining({
        dispatch_id: started.dispatch.id,
        contract_version: CURRENT_CONTRACT_VERSION,
        worker_state: 'ready',
        agent_terminal_handle: 'term_worker'
      })
    ])
  })

  it('retains an active supervised worker terminal', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retain active worker' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    expect(d.retainWorkerTerminalResource(started.dispatch.id)).toMatchObject({
      disposition: 'retained',
      resource: { lifecycle_state: 'retained', retained_reason: 'user_requested' }
    })
    expect(d.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
  })

  it('requeues an active Task before settling a worker whose terminal is missing', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'recover missing worker' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_missing',
      paneKey: 'tab_missing:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'pty-missing:22222222-2222-4222-8222-222222222222',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    expect(
      d.reconcileMissingWorkerTerminal(started.dispatch.id, 'worker terminal is no longer live')
    ).toMatchObject({
      state: 'abandoned',
      stage: 'terminal_missing',
      last_error: 'worker terminal is no longer live'
    })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 1,
      last_failure: 'worker terminal is no longer live'
    })
    expect(d.getTask(task.id)?.status).toBe('ready')

    d.reconcileMissingWorkerTerminal(started.dispatch.id, 'duplicate recovery')
    expect(d.getDispatchContextById(started.dispatch.id)?.failure_count).toBe(1)
    expect(d.getTask(task.id)?.status).toBe('ready')
  })

  it('commits worker-start mutation acceptance with the starting Dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'atomic acceptance' })
    const mutationReceipt = {
      callerFingerprint: 'caller_fingerprint',
      requestId: 'worker_start_request',
      method: 'orchestration.workerStart',
      payloadHash: 'payload_hash'
    }

    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current' },
      mutationReceipt
    })

    expect(d.getMutationReceipt('caller_fingerprint', 'worker_start_request')).toMatchObject({
      state: 'pending',
      method: 'orchestration.workerStart'
    })
    expect(d.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'accepted'
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
  })

  it('rolls back worker-start mutation acceptance when the Task cannot start', () => {
    const d = createDb()

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: 'task_missing',
        startOptions: {},
        mutationReceipt: {
          callerFingerprint: 'caller_fingerprint',
          requestId: 'invalid_worker_start',
          method: 'orchestration.workerStart',
          payloadHash: 'payload_hash'
        }
      })
    ).toThrow('was not found')
    expect(d.getMutationReceipt('caller_fingerprint', 'invalid_worker_start')).toBeUndefined()
  })

  it('fails a composed start without losing residual resource receipts', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'worker' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'terminal_created',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }],
      residualResources: [{ kind: 'terminal', id: 'term_worker' }]
    })

    expect(d.failWorkerStart(started.dispatch.id, 'agent_readiness', 'timed out')).toMatchObject({
      state: 'failed',
      stage: 'agent_readiness',
      last_error: 'timed out',
      residual_resources: expect.stringContaining('term_worker')
    })
    expect(d.getTask(task.id)?.status).toBe('failed')
  })

  it('allows retry only from the Task current terminal Dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retry current' })
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })
    d.failWorkerStart(second.dispatch.id, 'agent_readiness', 'second failed')

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      })
    ).toThrow('cannot retry')
    expect(
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: second.dispatch.id,
        startOptions: {}
      }).worker.state
    ).toBe('starting')
  })

  it('blocks retry until the current failed Dispatch terminal resource is settled', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retry after exact terminal settlement' })
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: first.dispatch.id,
      handle: 'term_failed',
      paneKey: 'tab_failed:leaf_failed',
      processIncarnation: 'daemon:pty:failed',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      worktreeId: 'repo::failed-generation',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      })
    ).toThrowError(expect.objectContaining({ code: 'terminal_resource_unsettled' }))

    const requested = d.requestWorkerTerminalRelease(first.dispatch.id)
    expect(requested).toMatchObject({ disposition: 'requested' })
    if (!requested.resource) {
      throw new Error('expected worker terminal resource')
    }
    d.markWorkerTerminalReleaseUnknown(requested.resource.id, 'close outcome unavailable')
    expect(
      d.settleDeadWorkerTerminalRelease({
        requestingDispatchId: first.dispatch.id,
        resourceId: requested.resource.id,
        processIncarnation: 'daemon:pty:failed'
      })
    ).toMatchObject({ disposition: 'released' })
    expect(
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      }).worker.state
    ).toBe('starting')
  })

  it('retries a ready Task after its latest unexpected-exit resource is exactly released', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retry ready task after unexpected exit' })
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: first.dispatch.id,
      handle: 'term_unexpected_exit',
      paneKey: 'tab_unexpected_exit:leaf_unexpected_exit',
      processIncarnation: 'daemon:pty:unexpected-exit',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      worktreeId: 'repo::unexpected-exit-generation',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    d.markWorkerDispatchReady(first.dispatch.id)
    d.failDispatch(first.dispatch.id, 'provider exited unexpectedly', {
      workerProcessExited: true,
      terminationReason: 'unknown'
    })
    expect(d.getTask(task.id)?.status).toBe('ready')

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      })
    ).toThrowError(expect.objectContaining({ code: 'terminal_resource_unsettled' }))

    const requested = d.requestWorkerTerminalRelease(first.dispatch.id)
    if (!requested.resource) {
      throw new Error('expected worker terminal resource')
    }
    d.markWorkerTerminalReleaseUnknown(requested.resource.id, 'exit awaiting proof')
    d.settleDeadWorkerTerminalRelease({
      requestingDispatchId: first.dispatch.id,
      resourceId: requested.resource.id,
      processIncarnation: 'daemon:pty:unexpected-exit'
    })

    expect(
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      }).worker.state
    ).toBe('starting')
  })

  it('preserves a user-owned failed attempt while accepting its retry', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retry after user takeover' })
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: first.dispatch.id,
      handle: 'term_user_owned',
      paneKey: 'tab_user_owned:leaf_user_owned',
      processIncarnation: 'daemon:pty:user-owned',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      worktreeId: 'repo::user-owned-generation',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    expect(d.markWorkerTerminalUserOwned('tab_user_owned:leaf_user_owned')).toBe(1)
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'user took over failed attempt')

    expect(
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      }).worker.state
    ).toBe('starting')
    expect(d.getWorkerTerminalResourceByOwner(first.dispatch.id)).toMatchObject({
      lifecycle_state: 'user_owned',
      retained_reason: 'user_takeover'
    })
  })

  it('treats abandon of a superseded Dispatch as a no-op', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale abandon' })
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: second.dispatch.id,
      handle: 'term_replacement',
      paneKey: 'tab_replacement:leaf_replacement',
      processIncarnation: 'runtime:pty:2',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(second.dispatch.id)

    expect(d.abandonWorkerDispatch(first.dispatch.id)).toMatchObject({
      disposition: 'stale',
      worker: { state: 'failed' }
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getWorkerDispatch(second.dispatch.id)?.state).toBe('ready')
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: second.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })
    expect(d.getTask(task.id)?.status).toBe('completed')
  })

  it('lets the stop fence win before a late worker completion', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'race' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    expect(d.beginWorkerStop(started.dispatch.id, 'runtime_test').disposition).toBe('stopping')
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(d.settleWorkerStop(started.dispatch.id).state).toBe('stopped')
    expect(d.getTask(task.id)?.status).toBe('blocked')
  })

  it('allows explicit stop recovery from uncertain local and remote starts', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'uncertain local start' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'connection lost')

    expect(d.beginWorkerStop(started.dispatch.id, 'runtime_test')).toMatchObject({
      disposition: 'stopping',
      worker: { state: 'stopping' }
    })

    d.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote_unknown',
      taskId: 'task_remote_unknown',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'remote_unknown_start',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_unknown_payload'
      }
    })
    d.recordRemoteAttachmentStage({
      dispatchId: 'ctx_remote_unknown',
      stage: 'agent_readiness',
      state: 'start_unknown',
      terminalHandle: 'term_remote_worker'
    })

    expect(d.beginRemoteAttachmentStop('ctx_remote_unknown')).toMatchObject({
      state: 'stopping',
      stage: 'stop_requested',
      capability_hash: null
    })
  })

  it('bounds remote attachment lookup across pane remints and malformed suffix collisions', () => {
    const d = createDb()
    const leafId = '11111111-1111-4111-8111-111111111111'
    const attach = (dispatchId: string, paneKey: string): void => {
      d.createRemoteDispatchAttachment({
        dispatchId,
        taskId: `task_${dispatchId}`,
        homePeerFingerprint: 'home_peer',
        protocolVersion: 1,
        runtimeEpoch: 'worker_epoch',
        mutationReceipt: {
          callerFingerprint: 'home_peer',
          requestId: `request_${dispatchId}`,
          method: 'orchestration.federationAttachStart',
          payloadHash: `payload_${dispatchId}`
        }
      })
      d.prepareRemoteAttachmentAuthority({
        dispatchId,
        paneKey,
        processIncarnation: `process_${dispatchId}`,
        worktreeId: 'repo::worktree',
        terminalHandle: `term_${dispatchId}`,
        setupState: 'not_applicable',
        effects: []
      })
    }

    attach('ctx_valid_old', `tab_old:${leafId}`)
    for (let index = 0; index < 64; index += 1) {
      attach(`ctx_malformed_${index}`, `:${leafId}`)
    }

    expect(d.findActiveRemoteAttachmentForPane(`tab_reminted:${leafId}`)?.dispatch_id).toBe(
      'ctx_valid_old'
    )
    attach('ctx_valid_new', `tab_new:${leafId}`)
    expect(d.findActiveRemoteAttachmentForPane(`tab_reminted:${leafId}`)?.dispatch_id).toBe(
      'ctx_valid_new'
    )
    expect(d.findActiveRemoteAttachmentForPane(`tab_old:${leafId}`)?.dispatch_id).toBe(
      'ctx_valid_new'
    )
  })

  it('returns already-settled when completion wins before stop', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'race' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })

    expect(d.beginWorkerStop(started.dispatch.id, 'runtime_test')).toMatchObject({
      disposition: 'already_settled',
      worker: { state: 'succeeded' }
    })
  })
})
