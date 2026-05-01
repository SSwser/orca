import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appPathMocks = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appPathMocks.getPath
  }
}))

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
        return 'C:/Users/alice/AppData/Roaming/orca'
      }
      throw new Error(`unexpected path key: ${name}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the packaged app namespace by default', async () => {
    const paths = await import('./runtime-paths')

    expect(normalize(paths.getAgentHooksDir())).toBe(
      'C:/Users/alice/AppData/Roaming/orca/agent-hooks'
    )
  })

  it('follows the dev userData namespace for dev builds', async () => {
    appPathMocks.getPath.mockImplementation((name) => {
      if (name === 'appData') {
        return 'C:/Users/alice/AppData/Roaming'
      }
      if (name === 'userData') {
        return 'C:/Users/alice/AppData/Roaming/orca-dev'
      }
      throw new Error(`unexpected path key: ${name}`)
    })

    const paths = await import('./runtime-paths')

    expect(normalize(paths.getAgentHooksDir())).toBe(
      'C:/Users/alice/AppData/Roaming/orca-dev/agent-hooks'
    )
  })

  it('returns endpoint and metadata paths under the active runtime root', async () => {
    appPathMocks.getPath.mockImplementation((name) => {
      if (name === 'appData') {
        return 'C:/Users/alice/AppData/Roaming'
      }
      if (name === 'userData') {
        return 'C:/Users/alice/AppData/Roaming/orca-dev'
      }
      throw new Error(`unexpected path key: ${name}`)
    })

    const paths = await import('./runtime-paths')

    expect(normalize(paths.getAgentHookEndpointPath())).toBe(
      'C:/Users/alice/AppData/Roaming/orca-dev/agent-hooks/endpoint.json'
    )
    expect(normalize(paths.getAgentHookMetadataPath())).toBe(
      'C:/Users/alice/AppData/Roaming/orca-dev/agent-hooks/runtime.json'
    )
  })

  it('returns a platform-appropriate launcher path under the active runtime root', async () => {
    appPathMocks.getPath.mockImplementation((name) => {
      if (name === 'appData') {
        return 'C:/Users/alice/AppData/Roaming'
      }
      if (name === 'userData') {
        return 'C:/Users/alice/AppData/Roaming/orca-dev'
      }
      throw new Error(`unexpected path key: ${name}`)
    })

    const paths = await import('./runtime-paths')
    const launcher = normalize(paths.getAgentHookLauncherPath())
    const expectedFile = process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
    expect(launcher).toBe(`C:/Users/alice/AppData/Roaming/orca-dev/agent-hooks/${expectedFile}`)
  })
})
