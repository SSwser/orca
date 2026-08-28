import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { oxlintPath, resolveOxlintPath } from './oxlint-executable.mjs'

describe('Oxlint executable', () => {
  it('resolves the workspace JavaScript entrypoint', () => {
    expect(oxlintPath).toBe(resolveOxlintPath())
    expect(oxlintPath).toMatch(/[\\/]oxlint[\\/]bin[\\/]oxlint$/)
  })

  it('runs through Node without relying on a platform shim', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('config/scripts/oxlint-executable.mjs'), '--version'],
      { encoding: 'utf8' }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^Version: \d+\.\d+\.\d+/)
  })
})
