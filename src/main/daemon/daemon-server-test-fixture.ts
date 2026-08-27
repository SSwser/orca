import { connect, type Server, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import { encodeNdjson } from './ndjson'
import { PROTOCOL_VERSION, type DaemonRequest } from './types'
import type { SubprocessHandle } from './session-subprocess-handle'

export const confirmForegroundProcessMock = vi.fn(async () => 'droid')

export function createMockSubprocess(): SubprocessHandle & {
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 55555,
    getForegroundProcess: vi.fn(() => null),
    confirmForegroundProcess: confirmForegroundProcessMock,
    write: vi.fn(),
    writeAcknowledged: vi.fn(() => true),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

export type DaemonServerPrivate = {
  lifecycle: { server: Server | null }
  preparations: { pending: Map<string, Set<unknown>> }
  host: { kill: (sessionId: string, opts?: { immediate?: boolean }) => void | Promise<void> }
  connections: {
    clients: Map<
      string,
      {
        clientId: string
        controlSocket: Socket
        streamSocket: Socket | null
        authenticatedPairEstablished: boolean
      }
    >
  }
  requestRouter: { route(clientId: string, request: DaemonRequest): Promise<unknown> }
}

export async function connectRawHello(
  socketPath: string,
  tokenPath: string,
  role: 'control' | 'stream',
  clientId: string
): Promise<Socket> {
  const socket = connect(socketPath)
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.write(
    encodeNdjson({
      type: 'hello',
      version: PROTOCOL_VERSION,
      token: readFileSync(tokenPath, 'utf-8').trim(),
      clientId,
      role
    })
  )
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
    }
    const onData = (data: Buffer): void => {
      cleanup()
      const parsed = JSON.parse(data.toString().trim()) as { ok?: boolean; error?: string }
      if (parsed.ok) {
        resolve()
      } else {
        reject(new Error(parsed.error ?? 'hello rejected'))
      }
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
  return socket
}
