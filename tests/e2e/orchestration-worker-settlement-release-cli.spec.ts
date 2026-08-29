import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'
import Database from '../../src/main/sqlite/sync-database'
import type { RuntimeTerminalListResult, RuntimeTerminalRead } from '../../src/shared/runtime-types'

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-settlement-release-'))
const cliLedgerPath = path.join(fakeCliDir, 'cli.jsonl')
const authorityLedgerPath = path.join(fakeCliDir, 'authority.jsonl')
const cliEntry = path.join(process.cwd(), 'out', 'cli', 'index.js')
const fakeCodexSource = `
const { appendFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const appendAuthority = (event) => appendFileSync(
  process.env.ORCA_E2E_AUTHORITY_LEDGER,
  JSON.stringify(event) + '\\n'
)
appendAuthority({ event: 'spawn', argv: process.argv.slice(2) })
async function emitAuthorityHook(hookEventName, prompt) {
  const port = process.env.ORCA_AGENT_HOOK_PORT
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  const launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
  if (!port || !token || !launchToken || !process.env.ORCA_PANE_KEY) {
    appendAuthority({ hookEventName, event: 'missing-env', port: Boolean(port), token: Boolean(token), launchToken: Boolean(launchToken), paneKey: Boolean(process.env.ORCA_PANE_KEY) })
    return
  }
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/hook/codex', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': token
      },
      body: JSON.stringify({
        paneKey: process.env.ORCA_PANE_KEY,
        tabId: process.env.ORCA_TAB_ID,
        worktreeId: process.env.ORCA_WORKTREE_ID,
        env: process.env.ORCA_AGENT_HOOK_ENV,
        version: process.env.ORCA_AGENT_HOOK_VERSION,
        launchToken,
        payload: {
          hook_event_name: hookEventName,
          session_id: '019fed4d-fd6b-7b9f-9d46-4faf12cd9844',
          prompt
        }
      })
    })
    appendAuthority({ hookEventName, event: 'response', status: response.status })
  } catch (error) {
    appendAuthority({ hookEventName, event: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
const startupPrompt = process.argv.at(-1) || ''
let capability = startupPrompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1] || null
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
void emitAuthorityHook('SessionStart', startupPrompt)
  .then(() => emitAuthorityHook('UserPromptSubmit', startupPrompt))
  .then(() => process.stdout.write('\\u001b]0;Codex Working\\u0007ACK\\n'))
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  const encoded = input.match(/ORCA_E2E_WORKER_DONE:([A-Za-z0-9+/=]+)/)?.[1]
  if (!encoded || !capability) return
  const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  const args = [
    'orchestration', 'send',
    '--from', request.mismatch ? 'term_foreign' : process.env.ORCA_TERMINAL_HANDLE,
    '--dispatch-capability', capability,
    '--to', request.coordinator,
    '--type', 'worker_done',
    '--subject', request.mismatch ? 'wrong sender' : 'completed',
    '--body', 'Compiled CLI E2E worker completion.',
    '--task-id', request.taskId,
    '--dispatch-id', request.dispatchId,
    '--outcome', 'succeeded',
    '--json'
  ]
  const result = spawnSync(process.execPath, [process.env.ORCA_E2E_CLI_ENTRY, ...args], {
    env: process.env,
    encoding: 'utf8'
  })
  appendFileSync(
    process.env.ORCA_E2E_CLI_LEDGER,
    JSON.stringify({ mismatch: request.mismatch, args, status: result.status, stdout: result.stdout, stderr: result.stderr }) + '\\n'
  )
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
setInterval(() => {}, 60_000)
`

if (process.platform === 'win32') {
  const fakeCodexScript = path.join(fakeCliDir, 'fake-codex.js')
  writeFileSync(fakeCodexScript, fakeCodexSource)
  writeFileSync(
    path.join(fakeCliDir, 'codex.cmd'),
    '@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n'
  )
  writeFileSync(
    path.join(fakeCliDir, 'codex.ps1'),
    '& node (Join-Path $PSScriptRoot "fake-codex.js") @args\r\nexit $LASTEXITCODE\r\n'
  )
  const nativeDir = path.join(
    fakeCliDir,
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin'
  )
  mkdirSync(nativeDir, { recursive: true })
  copyFileSync(process.execPath, path.join(nativeDir, 'codex.exe'))
} else {
  const executable = path.join(fakeCliDir, 'codex')
  writeFileSync(executable, `#!/usr/bin/env node\n${fakeCodexSource}`)
  chmodSync(executable, 0o755)
}

const test = base.extend({
  launchEnv: [
    {
      [process.platform === 'win32' ? 'Path' : 'PATH']:
        `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_CLI_ENTRY: cliEntry,
      ORCA_E2E_CLI_LEDGER: cliLedgerPath,
      ORCA_E2E_AUTHORITY_LEDGER: authorityLedgerPath
    },
    { option: true }
  ]
})

type CliLedgerEntry = {
  mismatch: boolean
  status: number
  stdout: string
  stderr: string
}

function readCliLedger(): CliLedgerEntry[] {
  if (!existsSync(cliLedgerPath)) {
    return []
  }
  return readFileSync(cliLedgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliLedgerEntry)
}

function readAuthorityLedger(): unknown[] {
  if (!existsSync(authorityLedgerPath)) {
    return []
  }
  return readFileSync(authorityLedgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

function invokeCompiledCli(userDataDir: string, args: string[]) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8'
  })
}

function encodeWorkerDone(input: {
  coordinator: string
  taskId: string
  dispatchId: string
  mismatch: boolean
}): string {
  return Buffer.from(JSON.stringify(input)).toString('base64')
}

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

test('compiled CLI rejects false completion and retains an unverifiable worker', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  rmSync(cliLedgerPath, { force: true })
  rmSync(authorityLedgerPath, { force: true })
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(
    async (fakeCodexScript) => {
      const state = window.__store?.getState()
      await state?.updateSettings({
        agentDefaultArgs: { ...state.settings.agentDefaultArgs, codex: fakeCodexScript }
      })
    },
    process.platform === 'win32' ? path.join(fakeCliDir, 'fake-codex.js') : ''
  )
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const coordinatorPane = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: coordinatorPane.paneKey
  })
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Compiled CLI settlement and release E2E',
    from: coordinator.result.terminal.handle
  })
  const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
    spec: 'Respond ACK and await the completion marker.',
    run: run.result.run.id,
    callerTerminalHandle: coordinator.result.terminal.handle
  })
  const coordinatorTerminal = await client.call<{ terminal: { worktreeId: string } }>(
    'terminal.show',
    { terminal: coordinator.result.terminal.handle }
  )
  await expect
    .poll(async () => {
      const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
      return listed.result.worktrees.some(
        (worktree) => worktree.id === coordinatorTerminal.result.terminal.worktreeId
      )
    })
    .toBe(true)
  const started = await client.call<{
    state: string
    stage: string
    lastError?: string
    effects: { kind: string; role?: string; id?: string }[]
  }>('orchestration.workerStart', {
    task: task.result.task.id,
    from: coordinator.result.terminal.handle,
    agent: 'codex',
    timeoutMs: 15_000
  })
  expect(
    started.result.state,
    JSON.stringify({ started: started.result, authority: readAuthorityLedger() })
  ).toBe('ready')
  expect(started.result.stage).toBe('input_accepted')
  const workerHandle = started.result.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'agent'
  )?.id
  expect(workerHandle).toBeTruthy()

  let worker = (
    await client.call<RuntimeTerminalListResult>('terminal.list')
  ).result.terminals.find((terminal) => terminal.handle === workerHandle)
  await expect
    .poll(async () => {
      const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
      worker = listed.result.terminals.find((terminal) => terminal.handle === workerHandle)
      if (!worker) {
        return ''
      }
      const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
        terminal: worker.handle,
        limit: 200
      })
      return read.result.terminal.tail.join('\n')
    })
    .toContain('ACK')
  const dispatch = await client.call<{ dispatch: { id: string; status: string } | null }>(
    'orchestration.dispatchShow',
    { task: task.result.task.id }
  )
  expect(dispatch.result.dispatch?.status).toBe('dispatched')

  const baseMarker = {
    coordinator: coordinator.result.terminal.handle,
    taskId: task.result.task.id,
    dispatchId: dispatch.result.dispatch!.id
  }
  await client.call('terminal.send', {
    terminal: workerHandle,
    text: `ORCA_E2E_WORKER_DONE:${encodeWorkerDone({ ...baseMarker, mismatch: true })}`,
    enter: true
  })
  await expect.poll(() => readCliLedger()).toHaveLength(1)
  const rejected = readCliLedger()[0]!
  expect.soft(rejected.status).not.toBe(0)
  expect.soft(JSON.parse(rejected.stdout)).toMatchObject({
    ok: false,
    error: { code: 'dispatch_capability_invalid' }
  })
  const stillDispatched = await client.call<{ dispatch: { status: string } | null }>(
    'orchestration.dispatchShow',
    { task: task.result.task.id }
  )
  expect(stillDispatched.result.dispatch?.status).toBe('dispatched')

  await client.call('terminal.send', {
    terminal: workerHandle,
    text: `ORCA_E2E_WORKER_DONE:${encodeWorkerDone({ ...baseMarker, mismatch: false })}`,
    enter: true
  })
  await expect.poll(() => readCliLedger()).toHaveLength(2)
  const completed = readCliLedger()[1]!
  expect(completed.status).toBe(0)
  expect.soft(JSON.parse(completed.stdout)).toMatchObject({
    ok: true,
    result: { lifecycle: { action: 'completed' } }
  })
  await expect
    .poll(async () => {
      const current = await client.call<{ dispatch: { status: string } | null }>(
        'orchestration.dispatchShow',
        { task: task.result.task.id }
      )
      return current.result.dispatch?.status
    })
    .toBe('completed')

  await client.call('terminal.close', { terminal: workerHandle })
  await expect
    .poll(async () => {
      const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
      return listed.result.terminals.some((terminal) => terminal.handle === workerHandle)
    })
    .toBe(false)
  const db = new Database(path.join(userDataDir, 'orchestration.db'))
  try {
    db.prepare(
      `UPDATE worker_execution_resources
       SET lifecycle_state = 'release_unknown',
           release_error = 'terminal inventory was lost after exact exit'
       WHERE owner_dispatch_id = ?`
    ).run(dispatch.result.dispatch!.id)
  } finally {
    db.close()
  }

  const released = invokeCompiledCli(userDataDir, [
    'orchestration',
    'worker-release',
    '--dispatch',
    dispatch.result.dispatch!.id,
    '--json'
  ])
  expect(released.status, `${released.stderr}\n${released.stdout}`).toBe(1)
  expect.soft(JSON.parse(released.stdout)).toMatchObject({
    ok: true,
    result: { state: 'release_unknown', processAction: 'none' }
  })
  const verified = new Database(path.join(userDataDir, 'orchestration.db'))
  try {
    expect
      .soft(
        verified
          .prepare(
            `SELECT lifecycle_state
           FROM worker_execution_resources WHERE owner_dispatch_id = ?`
          )
          .get(dispatch.result.dispatch!.id)
      )
      .toEqual({ lifecycle_state: 'release_unknown' })
  } finally {
    verified.close()
  }
  const coordinatorStillLive = await client.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${worktreeId}`
  })
  expect(
    coordinatorStillLive.result.terminals.some(
      (terminal) => terminal.handle === coordinator.result.terminal.handle
    )
  ).toBe(true)
})
