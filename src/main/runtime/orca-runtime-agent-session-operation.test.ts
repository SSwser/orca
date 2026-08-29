import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type * as LocalCodexTargetModule from './local-codex-agent-process-target'
import type {
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('./local-codex-agent-process-target', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalCodexTargetModule>()),
  fingerprintAgentProcessTarget: () => 'c'.repeat(64)
}))

function operationId(now = Date.now()): string {
  return `${now}-0123456789abcdef0123456789abcdef`
}

function request(
  clientOperationId: string,
  overrides: Partial<RuntimeCreateAgentSessionRequest> = {}
): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId,
    worktree: 'id:worktree-1',
    agent: 'codex',
    prompt: 'do the thing',
    presentation: 'background',
    ...overrides
  }
}

function terminal() {
  return {
    handle: 'term_operation',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-operation',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const,
    agentSessionCreateOperation: {
      operationId: 'a'.repeat(43),
      payloadFingerprint: 'b'.repeat(64)
    }
  }
}

function executionStart() {
  return {
    operationId: 'a'.repeat(43),
    payloadFingerprint: 'b'.repeat(64),
    targetFingerprint: 'c'.repeat(64),
    terminalHandle: 'term_operation',
    launchToken: 'launch-token',
    writeFence: { ownerId: 'ctx_worker', generation: 'generation-1' },
    semanticBaselineAt: Date.now() - 1_000,
    timeoutMs: 1_000
  }
}

function mockAcceptedExecutionStart(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue({
    paneKey: terminal().paneKey,
    processIncarnation: 'daemon:pty:incarnation',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'codex-session' },
    observedAt: Date.now()
  })
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
    runtimeId: 'runtime-test',
    terminalHandle: terminal().handle,
    ptyId: terminal().ptyId,
    worktreeId: terminal().worktreeId,
    paneKey: terminal().paneKey,
    processIncarnation: 'daemon:pty:incarnation',
    launchTokenHash: createHash('sha256').update('launch-token').digest('hex'),
    hostScope: {
      kind: 'local',
      hostId: 'local',
      restartCustody: {
        kind: 'windows_daemon_job',
        daemonPid: 100,
        daemonStartedAtMs: 1,
        daemonLaunchNonce: 'nonce'
      }
    }
  })
}

function bindExecutionStartTerminal(
  runtime: OrcaRuntimeService,
  fingerprint = 'b'.repeat(64)
): void {
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    probePtyLiveness: async () => true
  })
  runtime.registerPreAllocatedHandleForPty(terminal().ptyId, terminal().handle)
  runtime.registerPty(terminal().ptyId, terminal().worktreeId, null, {
    tabId: terminal().tabId,
    leafId: terminal().paneKey.split(':')[1]!,
    incarnationId: 'daemon:pty:incarnation' as never,
    agentSessionCreateOperation: {
      operationId: executionStart().operationId,
      payloadFingerprint: fingerprint
    }
  })
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue(terminal() as never)
  mockAcceptedExecutionStart(runtime)
}

function createRuntime(
  provider?: {
    supportsAgentSessionClaims?: () => boolean
    supportsAgentSessionCreateOperations?: () => boolean
  },
  extraDeps?: ConstructorParameters<typeof OrcaRuntimeService>[2]
) {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    {
      ...extraDeps,
      ...(provider ? { getLocalProvider: () => provider as never } : {})
    }
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  return runtime
}

describe('agent-session create operation ledger', () => {
  it('carries one complete Codex first turn in the deterministic execution start', async () => {
    const runtime = createRuntime({
      supportsAgentSessionCreateOperations: () => true
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    mockAcceptedExecutionStart(runtime)
    const id = operationId()
    const start = executionStart()
    const { launchToken: _launchToken, ...receiptStart } = start

    const prompt = 'complete worker preamble\n"quoted" CJK 任务 `literal`'
    await expect(
      runtime.createAgentSession(
        request(id, {
          prompt,
          promptDelivery: 'auto-submit',
          executionStart: start
        })
      )
    ).resolves.toMatchObject({
      disposition: 'created',
      executionStartReceipt: {
        ...receiptStart,
        launchTokenHash: expect.any(String),
        semanticObservedAt: expect.any(Number),
        providerSession: { key: 'session_id', id: 'codex-session' }
      }
    })
    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({
        spawnTarget: {
          kind: 'agent-process',
          executable: expect.any(String),
          argv: expect.arrayContaining([prompt]),
          envPatch: expect.any(Object),
          expectedProcess: 'codex'
        },
        preAllocatedHandle: start.terminalHandle,
        agentSessionCreateOperationId: start.operationId,
        requireHostCrashContainment: true
      })
    )
    expect(createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('command')
  })

  it('rejects a changed structured target before creating a terminal', async () => {
    const runtime = createRuntime({ supportsAgentSessionCreateOperations: () => true })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(
      runtime.createAgentSession(
        request(operationId(), {
          promptDelivery: 'auto-submit',
          executionStart: {
            ...executionStart(),
            targetFingerprint: 'd'.repeat(64)
          }
        })
      )
    ).rejects.toThrow('worker_execution_start_conflict')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('keeps the lower execution identity stable across a full main-runtime restart', async () => {
    const start = executionStart()
    const id = operationId()
    const operationIds: string[] = []
    for (const runtime of [
      createRuntime({ supportsAgentSessionCreateOperations: () => true }),
      createRuntime({ supportsAgentSessionCreateOperations: () => true })
    ]) {
      vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_worktree, options) => {
        operationIds.push(options?.agentSessionCreateOperationId ?? '')
        return terminal()
      })
      mockAcceptedExecutionStart(runtime)
      await runtime.createAgentSession(
        request(id, {
          prompt: 'same complete worker turn',
          promptDelivery: 'auto-submit',
          executionStart: start
        })
      )
    }

    expect(operationIds).toEqual([start.operationId, start.operationId])
  })

  it.each(['claude', 'cursor'] as const)(
    'rejects unsupported %s execution start before spawning',
    async (agent) => {
      const runtime = createRuntime({ supportsAgentSessionCreateOperations: () => true })
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

      await expect(
        runtime.createAgentSession(
          request(operationId(), {
            agent,
            promptDelivery: 'auto-submit',
            executionStart: executionStart()
          })
        )
      ).rejects.toThrow('worker_execution_start_unsupported')
      expect(createTerminal).not.toHaveBeenCalled()
    }
  )

  it('inspects exact started, accepted, and conflicting execution identity', async () => {
    const runtime = createRuntime()
    bindExecutionStartTerminal(runtime)
    vi.mocked(runtime.getExactWorkerProviderSession).mockReturnValueOnce(null)

    await expect(
      runtime.inspectAgentSessionExecutionStart('id:worktree-1', executionStart())
    ).resolves.toMatchObject({ verdict: 'started', terminalHandle: terminal().handle })
    await expect(
      runtime.inspectAgentSessionExecutionStart('id:worktree-1', executionStart())
    ).resolves.toMatchObject({
      verdict: 'accepted',
      receipt: { semanticObservedAt: expect.any(Number) }
    })
    await expect(
      runtime.inspectAgentSessionExecutionStart('id:worktree-1', {
        ...executionStart(),
        payloadFingerprint: 'c'.repeat(64)
      })
    ).resolves.toEqual({ verdict: 'conflict' })
  })

  it('accepts a restarted provider turn through its persisted launch-token commitment', () => {
    const start = executionStart()
    const startedAt = start.semanticBaselineAt + 1
    const attest = vi.fn(() => ({
      paneKey: terminal().paneKey,
      source: 'hydrated_commitment' as const,
      providerTurn: {
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: 'restarted-codex-session' },
        acceptedAt: startedAt
      }
    }))
    const runtime = createRuntime(undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: terminal().paneKey,
          connectionId: null,
          receivedAt: startedAt + 1,
          stateStartedAt: startedAt,
          state: 'done',
          prompt: '',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'restarted-codex-session' },
          restoredUnconfirmed: true
        }
      ],
      attestAgentHookCompatibilityAuthority: attest
    })
    runtime.registerPreAllocatedHandleForPty(terminal().ptyId, terminal().handle)
    runtime.registerPty(terminal().ptyId, terminal().worktreeId, null, {
      tabId: terminal().tabId,
      leafId: terminal().paneKey.split(':')[1]!,
      incarnationId: 'daemon:pty:incarnation' as never,
      providerReattachLaunchIdentity: {
        incarnationId: 'daemon:pty:incarnation' as never,
        launchAgent: 'codex'
      },
      agentSessionCreateOperation: {
        operationId: start.operationId,
        payloadFingerprint: start.payloadFingerprint
      }
    })

    expect(
      runtime.getExactWorkerProviderSession(
        terminal().handle,
        start.semanticBaselineAt,
        start.launchToken
      )
    ).toMatchObject({
      processIncarnation: 'pty-operation:daemon:pty:incarnation',
      providerSession: { key: 'session_id', id: 'restarted-codex-session' },
      observedAt: startedAt
    })
    expect(attest).toHaveBeenCalledWith({
      paneKey: terminal().paneKey,
      launchTokenHash: createHash('sha256').update(start.launchToken).digest('hex'),
      connectionId: null,
      terminalProvenance: 'restored'
    })
  })

  it.each([
    [false, 'not_started'],
    [null, 'unverifiable'],
    [true, 'unverifiable']
  ] as const)('classifies absent terminal probe %s as %s', async (probe, verdict) => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('terminal_not_found'))
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      probePtyLiveness: async () => probe
    })

    await expect(
      runtime.inspectAgentSessionExecutionStart('id:worktree-1', executionStart())
    ).resolves.toEqual({ verdict })
  })

  it('selects legacy before trust, spawn, or ledger state for an old daemon', async () => {
    const provider = {
      supportsAgentSessionClaims: vi.fn(() => false),
      supportsAgentSessionCreateOperations: vi.fn(() => false)
    }
    const runtime = createRuntime(provider)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const internal = runtime as unknown as {
      markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    }
    const id = operationId()

    await expect(runtime.createAgentSession(request(id))).rejects.toThrow(
      'agent_session_legacy_required'
    )
    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
    expect(internal.markLocalWorkspaceTrustedForAgent).not.toHaveBeenCalled()

    provider.supportsAgentSessionCreateOperations.mockReturnValue(true)
    await expect(runtime.createAgentSession(request(id))).resolves.toMatchObject({
      disposition: 'created'
    })
    provider.supportsAgentSessionCreateOperations.mockReturnValue(false)
    await expect(runtime.createAgentSession(request(id))).resolves.toMatchObject({
      disposition: 'replayed'
    })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('requests exact client legacy fallback before nested SSH side effects', async () => {
    const runtime = createRuntime()
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1'
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('selects nested SSH legacy fallback before reading a Pi transcript path locally', async () => {
    const runtime = createRuntime()
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
      markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1'
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'pi',
        providerSession: {
          key: 'session_id',
          id: 'provider-session-1',
          transcriptPath: '/remote-only/pi/session.jsonl'
        }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
    expect(internal.markRemoteWorkspaceTrustedForAgent).not.toHaveBeenCalled()
  })

  it('replays the same completed operation without spawning again', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'created' })
    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('joins concurrent retries and conflicts on a changed fingerprint', async () => {
    const runtime = createRuntime()
    let finish!: (result: ReturnType<typeof terminal>) => void
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const id = operationId()
    const first = runtime.createAgentSession(request(id), { clientId: 'device-a' })
    const joined = runtime.createAgentSession(request(id), { clientId: 'device-a' })

    await expect(
      runtime.createAgentSession(request(id, { prompt: 'changed' }), { clientId: 'device-a' })
    ).rejects.toThrow('agent_session_operation_conflict')
    await expect(
      runtime.createAgentSession(request(id, { agentArgs: '--profile changed' }), {
        clientId: 'device-a'
      })
    ).rejects.toThrow('agent_session_operation_conflict')
    finish(terminal())
    await expect(first).resolves.toMatchObject({ disposition: 'created' })
    await expect(joined).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('isolates operation ids by authenticated caller', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await runtime.createAgentSession(request(id), { clientId: 'device-a' })
    await runtime.createAgentSession(request(id), { clientId: 'device-b' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('rejects an expired unseen operation before terminal creation', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const expired = operationId(Date.now() - 25 * 60 * 60 * 1_000)

    await expect(
      runtime.createAgentSession(request(expired), { clientId: 'device-a' })
    ).rejects.toThrow('agent_session_operation_expired')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('releases a failed pre-spawn operation for a safe retry', async () => {
    const runtime = createRuntime()
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValueOnce(new Error('pre-spawn failure'))
      .mockResolvedValueOnce(terminal())
    const id = operationId()

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      'pre-spawn failure'
    )
    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
    expect(createTerminal.mock.calls[0]?.[1]).toMatchObject({
      tabId: createTerminal.mock.calls[1]?.[1]?.tabId,
      leafId: createTerminal.mock.calls[1]?.[1]?.leafId,
      preAllocatedHandle: createTerminal.mock.calls[1]?.[1]?.preAllocatedHandle,
      agentSessionCreateOperationId:
        createTerminal.mock.calls[1]?.[1]?.agentSessionCreateOperationId
    })
    expect(createTerminal.mock.calls[0]?.[1]?.agentSessionCreateOperationId).toMatch(
      /^[A-Za-z0-9_-]{43}$/
    )
  })

  it.each([
    ['controller admission fails', 'agent_session_exited_during_start'],
    ['publication fails', 'post-spawn publication failure']
  ])('retains a replay fence when %s after physical spawn commit', async (_case, message) => {
    const runtime = createRuntime()
    const failure = new Error(message)
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (_worktree, opts) => {
        opts?.onPtySpawnCommitted?.()
        throw failure
      })
    const id = operationId()

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('retains a replay fence when the provider reports an unknown spawn outcome', async () => {
    const runtime = createRuntime()
    const failure = Object.assign(new Error('cleanup could not prove exit'), {
      agentSessionOperationOutcome: 'unknown' as const
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockRejectedValue(failure)
    const id = operationId()

    const attempts: Promise<RuntimeCreateAgentSessionResult>[] = [
      runtime.createAgentSession(request(id), { clientId: 'device-a' }),
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ]
    await expect(Promise.all(attempts)).rejects.toThrow(failure.message)
    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})
