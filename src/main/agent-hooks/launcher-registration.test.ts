import { describe, expect, it, vi } from 'vitest'

vi.mock('./runtime-paths', () => ({
  getAgentHookLauncherPath: () => 'C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd'
}))

describe('launcher registration contract', () => {
  it('renders Windows launcher command with agent argument', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    try {
      vi.resetModules()
      const { renderManagedHookLauncherCommand } = await import('./launcher-registration')

      expect(renderManagedHookLauncherCommand('claude')).toBe(
        '"C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd" claude'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders POSIX launcher command with agent argument', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    try {
      vi.resetModules()
      const { renderManagedHookLauncherCommand } = await import('./launcher-registration')

      expect(renderManagedHookLauncherCommand('cursor')).toBe(
        '/bin/sh "C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd" cursor'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('quotes launcher path on Windows to handle spaces', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    try {
      vi.resetModules()
      const { renderManagedHookLauncherCommand } = await import('./launcher-registration')

      expect(renderManagedHookLauncherCommand('codex')).toContain('"C:/Users/alice/')
      expect(renderManagedHookLauncherCommand('codex')).toContain('/launcher.cmd" codex')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
