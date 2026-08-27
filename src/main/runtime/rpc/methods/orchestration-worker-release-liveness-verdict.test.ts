import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import { completeWorkerTerminalRelease } from './orchestration-worker-release-completion'
import { reconcileWorkerTerminalProcessIncarnation } from '../../orchestration/worker-terminal-process-liveness'

const restartCustody = {
  kind: 'windows_daemon_job' as const,
  daemonPid: 4000,
  daemonStartedAtMs: 1_786_000_000_000,
  daemonLaunchNonce: 'daemon-incarnation-a'
}

const exactProcess = {
  id: 'pty-worker',
  incarnationId: 'incarnation-1',
  cwd: 'C:\\worker',
  title: 'codex'
}

describe('orchestration worker release liveness verdict', () => {
  it.each([
    {
      name: 'an explicit unverifiable verdict',
      close: {
        handle: 'term_worker',
        tabId: 'tab-worker',
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable' as const,
        ptyStopReason: 'its SSH provider is no longer registered'
      },
      detail: 'its SSH provider is no longer registered'
    },
    {
      name: 'a bare unconfirmed close',
      close: { handle: 'term_worker', tabId: 'tab-worker', ptyKilled: false },
      detail: 'the stop outcome could not be verified'
    }
  ])('does not release a worker after $name', async ({ close, detail }) => {
    const reason = 'its SSH provider is no longer registered'
    const resource = {
      id: 'resource-1',
      owner_dispatch_id: 'ctx-worker',
      terminal_handle: 'term_worker',
      pane_key: 'tab-worker:leaf-worker',
      process_incarnation: 'pty-worker:incarnation-1',
      host_scope: JSON.stringify({ kind: 'ssh', targetId: 'target-1' }),
      archive_source: 'terminal',
      archive_status: 'captured',
      lifecycle_state: 'release_requested'
    } as WorkerTerminalResourceRow
    const runtime = {
      showTerminal: vi.fn(async () => ({ handle: 'term_worker', connected: false })),
      getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
      getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
      getTerminalLivenessVerdict: vi.fn(() => ({ status: 'unverifiable', reason })),
      getOrchestrationDispatchAuthority: vi.fn(() => ({
        terminalHandle: 'term_worker',
        paneKey: 'tab-worker:leaf-worker',
        processIncarnation: 'pty-worker:incarnation-1',
        hostScope: { kind: 'ssh', targetId: 'target-1' }
      })),
      closeTerminal: vi.fn(async () => close),
      notifyMessageArrived: vi.fn()
    } as unknown as OrcaRuntimeService
    const markWorkerTerminalReleaseUnknown = vi.fn((_resourceId: string, releaseError: string) => ({
      ...resource,
      lifecycle_state: 'release_unknown',
      release_error: releaseError
    }))
    const db = {
      getWorkerDispatch: vi.fn(() => ({
        agent_terminal_handle: 'term_worker',
        created_at: '2026-08-16T00:00:00.000Z'
      })),
      isDispatchProcessCurrent: vi.fn(() => true),
      workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
      getWorkerTerminalArchive: vi.fn(() => ({ kind: 'transcript_pin' })),
      commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
        ...resource,
        lifecycle_state: 'release_closing'
      })),
      markWorkerTerminalReleaseUnknown
    } as unknown as OrchestrationDb

    await expect(
      completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: 'ctx-worker',
        resource
      })
    ).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'none',
      lastError: `The agent terminal was closed but its process could not be confirmed stopped: ${detail}.`
    })
    expect(markWorkerTerminalReleaseUnknown).toHaveBeenCalledWith(
      'resource-1',
      `The agent terminal was closed but its process could not be confirmed stopped: ${detail}.`
    )
  })
})

describe('cross-daemon worker process custody', () => {
  it.each([
    {
      name: 'legacy local inventory loss',
      scope: { kind: 'local' as const, hostId: 'local' as const },
      sessions: [],
      custody: 'unverifiable' as const,
      expected: 'unverifiable'
    },
    {
      name: 'live daemon after exact PTY inventory loss',
      scope: { kind: 'local' as const, hostId: 'local' as const, restartCustody },
      sessions: [],
      custody: 'live' as const,
      expected: 'unverifiable'
    },
    {
      name: 'exited exact daemon Job',
      scope: { kind: 'local' as const, hostId: 'local' as const, restartCustody },
      sessions: [],
      custody: 'exited' as const,
      expected: 'exited'
    },
    {
      name: 'unverifiable old daemon',
      scope: { kind: 'local' as const, hostId: 'local' as const, restartCustody },
      sessions: [],
      custody: 'unverifiable' as const,
      expected: 'unverifiable'
    },
    {
      name: 'changed process incarnation',
      scope: { kind: 'local' as const, hostId: 'local' as const, restartCustody },
      sessions: [{ ...exactProcess, incarnationId: 'incarnation-2' }],
      custody: 'live' as const,
      expected: 'unverifiable'
    },
    {
      name: 'matching terminal id without an exact incarnation',
      scope: { kind: 'local' as const, hostId: 'local' as const, restartCustody },
      sessions: [{ ...exactProcess, incarnationId: undefined }],
      custody: 'live' as const,
      expected: 'unverifiable'
    },
    {
      name: 'WSL inventory loss without exact subtree custody',
      scope: { kind: 'wsl' as const, hostId: 'local' as const, distro: 'Ubuntu' },
      sessions: [],
      custody: 'unverifiable' as const,
      expected: 'unverifiable'
    },
    {
      name: 'SSH host inventory absence',
      scope: { kind: 'ssh' as const, targetId: 'build-host' },
      sessions: [],
      custody: 'unverifiable' as const,
      expected: 'unverifiable'
    }
  ])('$name resolves as $expected', ({ scope, sessions, custody, expected }) => {
    expect(
      reconcileWorkerTerminalProcessIncarnation(
        'pty-worker:incarnation-1',
        sessions,
        scope,
        custody
      )
    ).toBe(expected)
  })

  it('accepts an exact live incarnation without reconstructing custody from its PID', () => {
    expect(
      reconcileWorkerTerminalProcessIncarnation('pty-worker:incarnation-1', [exactProcess], {
        kind: 'local',
        hostId: 'local'
      })
    ).toBe('live')
  })
})
