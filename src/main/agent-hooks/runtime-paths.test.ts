import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appPathMocks = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appPathMocks.getPath
  }
}))

// Why: path.join on Windows uses backslash separators while the assertions
// below describe the intended logical layout with forward slashes. Normalize
// before comparing so the contract holds on every platform.
function normalize(value: string): string {
  return value.replace(/\\/g, '/')
}

describe('agent hook runtime paths', () => {
  beforeEach(() => {
    appPathMocks.getPath.mockImplementation((name) => {
      if (name === 'appData') {
        return 'C:/Users/alice/AppData/Roaming'
      }
      if (name === 'userData') {
        return 'C:/Users/alice/AppData/Roaming/Orca-dev'
      }
      throw new Error(`unexpected path key: ${name}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('derives the global runtime root from appData rather than userData', async () => {
    const paths = await import('./runtime-paths')

    expect(normalize(paths.getGlobalAgentHooksDir())).toBe(
      'C:/Users/alice/AppData/Roaming/orca/agent-hooks'
    )
    expect(normalize(paths.getGlobalAgentHooksDir())).not.toContain('Orca-dev')
  })

  it('returns stable endpoint and metadata paths under the global runtime root', async () => {
    const paths = await import('./runtime-paths')

    expect(normalize(paths.getAgentHookEndpointPath())).toBe(
      'C:/Users/alice/AppData/Roaming/orca/agent-hooks/endpoint.json'
    )
    expect(normalize(paths.getAgentHookMetadataPath())).toBe(
      'C:/Users/alice/AppData/Roaming/orca/agent-hooks/runtime.json'
    )
  })

  it('returns a platform-appropriate launcher path under the global runtime root', async () => {
    const paths = await import('./runtime-paths')
    const launcher = normalize(paths.getAgentHookLauncherPath())
    const expectedFile = process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
    expect(launcher).toBe(`C:/Users/alice/AppData/Roaming/orca/agent-hooks/${expectedFile}`)
  })
})
