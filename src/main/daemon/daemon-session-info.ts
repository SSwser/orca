import type {
  AgentSessionCreateOperationIdentity,
  AgentSessionOwnerBinding
} from '../../shared/agent-session-host-authority'
import type { SessionState, ShellReadyState } from './types'

export type SessionInfo = {
  sessionId: string
  incarnationId?: string
  hostCrashContained?: true
  state: SessionState
  shellState: ShellReadyState
  isAlive: boolean
  terminalHandle?: string
  wslDistro?: string | null
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  agentSessionOwners?: AgentSessionOwnerBinding[]
  agentSessionCreateOperation?: AgentSessionCreateOperationIdentity
}
