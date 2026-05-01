import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>((name) => {
    if (name === 'appData') {
      return testDir
    }
    throw new Error(`Unexpected app.getPath(${name})`)
  })
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { ensureLauncherScript } from './launcher-script'

describe('ensureLauncherScript', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'launcher-script-test-'))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('creates launcher script on current platform', () => {
    ensureLauncherScript()

    const expectedName = process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
    const launcherPath = join(testDir, 'orca', 'agent-hooks', expectedName)
    expect(existsSync(launcherPath)).toBe(true)

    const content = readFileSync(launcherPath, 'utf-8')
    expect(content).toContain('endpoint.json')

    if (process.platform === 'win32') {
      expect(content).toContain('@echo off')
      expect(content).toContain('powershell')
      expect(content).toContain('ConvertFrom-Json')
      expect(content).toContain('$args[0]') // PowerShell agent dispatch
    } else {
      expect(content).toContain('#!/bin/sh')
      expect(content).toContain('curl')
      expect(content).toContain('$1') // Shell agent dispatch
    }
  })

  it('writes the launcher script idempotently (no-op if already present)', () => {
    ensureLauncherScript()
    const expectedName = process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
    const launcherPath = join(testDir, 'orca', 'agent-hooks', expectedName)

    const initialContent = readFileSync(launcherPath, 'utf-8')

    // Second call should be idempotent
    ensureLauncherScript()

    const finalContent = readFileSync(launcherPath, 'utf-8')
    expect(finalContent).toBe(initialContent)
  })

  it('launcher dispatches to /hook/<agent> based on first argument', () => {
    ensureLauncherScript()

    const expectedName = process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
    const launcherPath = join(testDir, 'orca', 'agent-hooks', expectedName)
    const content = readFileSync(launcherPath, 'utf-8')

    // Should construct URL with agent from first argument
    expect(content).toContain('/hook/')

    if (process.platform === 'win32') {
      expect(content).toContain('$args[0]') // PowerShell $args[0]
    } else {
      expect(content).toMatch(/\$1|\${1}|\$agent/) // Bash $1 or $agent variable
    }
  })

  it('launcher reads endpoint.json for URL and token', () => {
    ensureLauncherScript()

    const expectedName = process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
    const launcherPath = join(testDir, 'orca', 'agent-hooks', expectedName)
    const content = readFileSync(launcherPath, 'utf-8')

    expect(content).toContain('endpoint.json')

    if (process.platform === 'win32') {
      expect(content).toContain('ConvertFrom-Json')
      expect(content).toContain('$ep.url')
      expect(content).toContain('$ep.token')
    } else {
      expect(content).toContain('parse_endpoint')
      expect(content).toContain('url=')
      expect(content).toContain('token=')
    }
  })

  it('launcher includes fail-open guards for missing endpoint/empty input', () => {
    ensureLauncherScript()

    const expectedName = process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh'
    const launcherPath = join(testDir, 'orca', 'agent-hooks', expectedName)
    const content = readFileSync(launcherPath, 'utf-8')

    // Should exit 0 when endpoint.json is missing
    if (process.platform === 'win32') {
      expect(content).toContain('if not exist')
      expect(content).toContain('exit /b 0')
    } else {
      expect(content).toContain('if [ ! -r')
      expect(content).toContain('exit 0')
    }
  })
})
