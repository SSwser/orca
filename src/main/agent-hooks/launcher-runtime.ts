import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUPPORTED_RUNTIME_VERSION = 1

// Why: launcher scripts must rediscover endpoint coordinates from a stable
// global file rather than inheriting them through PTY env, so dev/release
// switches and config-file restores don't break hook execution.
export function readHookRuntimeState(runtimeRoot: string): {
  endpoint: { url: string }
  metadata: { version: number; publishedAt: number; endpointVersion: number; publisherPid: number }
} {
  const endpoint = JSON.parse(readFileSync(join(runtimeRoot, 'endpoint.json'), 'utf8'))
  const metadata = JSON.parse(readFileSync(join(runtimeRoot, 'runtime.json'), 'utf8'))

  if (metadata.version !== SUPPORTED_RUNTIME_VERSION) {
    throw new Error('Unsupported hook runtime metadata version')
  }

  return { endpoint, metadata }
}
