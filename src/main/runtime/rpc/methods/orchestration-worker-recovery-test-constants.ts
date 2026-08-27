export const RECOVERY_TEST = {
  coordinatorPane: 'tab_coord:11111111-1111-4111-8111-111111111111',
  workerPane: 'tab_worker:22222222-2222-4222-8222-222222222222',
  successorPane: 'tab_successor:33333333-3333-4333-8333-333333333333',
  revision: '0123456789abcdef0123456789abcdef01234567',
  sourceRestartScope: JSON.stringify({
    kind: 'local',
    hostId: 'local',
    restartCustody: {
      kind: 'windows_daemon_job',
      daemonPid: 8100,
      daemonStartedAtMs: 1_786_000_000_000,
      daemonLaunchNonce: 'source-recovery-daemon'
    }
  })
}
