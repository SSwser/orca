import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { getRelayPtyId } from '../provider/registry'
import type { RuntimePtySpawnState } from './spawn-state'

export function persistRuntimePtySshLease(ctx: RuntimePtySpawnState): void {
  const { args } = ctx
  if (!ctx.deps.store || !args.connectionId) {
    return
  }
  // SSH leases keep relay ids for remote reconciliation; bindings keep app-facing ids.
  ctx.deps.store.upsertSshRemotePtyLease({
    targetId: args.connectionId,
    ptyId: getRelayPtyId(args.connectionId, ctx.result.id),
    ...(typeof args.worktreeId === 'string' ? { worktreeId: args.worktreeId } : {}),
    ...(typeof args.tabId === 'string' ? { tabId: args.tabId } : {}),
    ...(typeof args.leafId === 'string' && isTerminalLeafId(args.leafId)
      ? { leafId: args.leafId }
      : {}),
    state: 'attached',
    lastAttachedAt: Date.now()
  })
}
