import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('launcher runtime discovery', () => {
  it('loads endpoint coordinates from runtime files without PTY env transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hook-runtime-'))
    writeFileSync(
      join(root, 'endpoint.json'),
      JSON.stringify({ url: 'http://127.0.0.1:4312/hook' })
    )
    writeFileSync(
      join(root, 'runtime.json'),
      JSON.stringify({ version: 1, publishedAt: 1234, endpointVersion: 1, publisherPid: 99 })
    )

    const { readHookRuntimeState } = await import('./launcher-runtime')

    expect(readHookRuntimeState(root)).toEqual({
      endpoint: { url: 'http://127.0.0.1:4312/hook' },
      metadata: { version: 1, publishedAt: 1234, endpointVersion: 1, publisherPid: 99 }
    })
  })

  it('rejects stale runtime metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hook-runtime-'))
    writeFileSync(
      join(root, 'endpoint.json'),
      JSON.stringify({ url: 'http://127.0.0.1:4312/hook' })
    )
    writeFileSync(
      join(root, 'runtime.json'),
      JSON.stringify({ version: 0, publishedAt: 1234, endpointVersion: 1, publisherPid: 99 })
    )

    const { readHookRuntimeState } = await import('./launcher-runtime')

    expect(() => readHookRuntimeState(root)).toThrow('Unsupported hook runtime metadata version')
  })
})
