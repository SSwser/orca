import { getProviderForPty } from '../provider/registry'

export async function confirmShellForegroundFromRuntimeController(ptyId: string): Promise<boolean> {
  try {
    return (await getProviderForPty(ptyId).confirmShellForeground?.(ptyId)) ?? false
  } catch {
    return false
  }
}
