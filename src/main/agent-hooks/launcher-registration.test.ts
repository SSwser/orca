import { describe, expect, it, vi } from 'vitest'

vi.mock('./runtime-paths', () => ({
  getAgentHookLauncherPath: () => 'C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd'
}))

describe('launcher registration contract', () => {
  it('renders one Windows launcher command shape for all agents', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    try {
      vi.resetModules()
      const { renderManagedHookLauncherCommand } = await import('./launcher-registration')

      expect(renderManagedHookLauncherCommand()).toBe(
        'C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders one POSIX launcher command shape for all agents', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    try {
      vi.resetModules()
      const { renderManagedHookLauncherCommand } = await import('./launcher-registration')

      expect(renderManagedHookLauncherCommand()).toBe(
        '/bin/sh "C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd"'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
