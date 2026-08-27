export type PtyRestartCustody = Readonly<{
  kind: 'windows_daemon_job'
  daemonPid: number
  daemonStartedAtMs: number
  daemonLaunchNonce: string
}>

export function parsePtyRestartCustody(value: unknown): PtyRestartCustody | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const custody = value as Record<string, unknown>
  if (
    custody.kind !== 'windows_daemon_job' ||
    !Number.isInteger(custody.daemonPid) ||
    (custody.daemonPid as number) <= 0 ||
    typeof custody.daemonStartedAtMs !== 'number' ||
    !Number.isFinite(custody.daemonStartedAtMs) ||
    custody.daemonStartedAtMs <= 0 ||
    typeof custody.daemonLaunchNonce !== 'string' ||
    custody.daemonLaunchNonce.length === 0 ||
    custody.daemonLaunchNonce.length > 128
  ) {
    return null
  }
  return {
    kind: 'windows_daemon_job',
    daemonPid: custody.daemonPid as number,
    daemonStartedAtMs: custody.daemonStartedAtMs,
    daemonLaunchNonce: custody.daemonLaunchNonce
  }
}

export function ptyRestartCustodiesEqual(
  left: PtyRestartCustody | undefined,
  right: PtyRestartCustody | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.daemonPid === right.daemonPid &&
      left.daemonStartedAtMs === right.daemonStartedAtMs &&
      left.daemonLaunchNonce === right.daemonLaunchNonce)
  )
}
