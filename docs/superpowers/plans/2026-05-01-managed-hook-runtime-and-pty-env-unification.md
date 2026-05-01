# Managed Hook Runtime and PTY Environment Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify managed hook runtime scope, launcher registration, endpoint discovery, and PTY spawn environment resolution so Windows hook execution and dev/release switching no longer fail due to duplicated platform logic or ambiguous environment semantics.

**Architecture:** Expand `src/main/agent-hooks/runtime-paths.ts` into the single source of runtime scope, move managed hook execution behind one shared launcher contract, and make launchers discover endpoint state from global runtime files rather than PTY env. In parallel, rename PTY spawn inputs to explicit categories and resolve one full spawn-ready env in the main process before local or daemon providers run.

**Tech Stack:** TypeScript, Electron main/preload/renderer, Vitest, pnpm

---

## File map

### Create
- `src/main/agent-hooks/runtime-paths.ts` — global runtime root, launcher path, endpoint path, metadata path, optional per-agent generated script paths
- `src/main/agent-hooks/launcher-registration.ts` — shared config-facing launcher registration contract
- `src/main/agent-hooks/launcher-runtime.ts` — launcher-side runtime discovery and metadata validation helpers
- `src/main/agent-hooks/runtime-paths.test.ts` — runtime root and path contract tests
- `src/main/agent-hooks/launcher-registration.test.ts` — shared launcher contract tests
- `src/main/agent-hooks/launcher-runtime.test.ts` — endpoint self-discovery and stale-state validation tests

### Modify
- `src/main/agent-hooks/server.ts` — publish endpoint + metadata to global runtime root; remove PTY transport export
- `src/main/agent-hooks/server.test.ts` — update endpoint/metadata expectations and PTY env expectations
- `src/main/agent-hooks/installer-utils.ts` — managed-entry matcher support for launcher registrations
- `src/main/agent-hooks/installer-utils.test.ts` — managed-entry cleanup coverage
- `src/main/claude/hook-service.ts` — register shared launcher contract
- `src/main/cursor/hook-service.ts` — register shared launcher contract
- `src/main/codex/hook-service.ts` — register shared launcher contract
- `src/main/gemini/hook-service.ts` — register shared launcher contract
- hook-service tests under each agent area, if present — schema assertions only
- `src/main/index.ts` — startup order and global runtime publication wiring
- `src/main/ipc/pty.ts` — full PTY env resolution pipeline
- `src/main/providers/types.ts` — explicit PTY env field names
- `src/preload/index.ts` — preload PTY spawn payload rename
- `src/renderer/src/components/terminal-pane/pty-connection.ts` — renderer PTY spawn payload rename
- `src/main/providers/local-pty-provider.ts` — remove host-env merge responsibility
- `src/main/daemon/pty-subprocess.ts` — remove inherited-env repair responsibility
- `src/main/ipc/pty.test.ts` — PTY full-env contract coverage
- provider/daemon PTY tests if needed for env contract parity

### Existing tests to reuse
- `src/main/ipc/pty.test.ts`
- `src/main/agent-hooks/server.test.ts`
- `src/main/agent-hooks/installer-utils.test.ts`
- `src/main/opencode/hook-service.test.ts` for endpoint-env dependency removal analogues if helpful
- `src/main/win32-utils.test.ts` only if launcher registration needs explicit Windows contract assertions

---

### Task 1: Add runtime path contract tests and shared runtime path module

**Files:**
- Create: `src/main/agent-hooks/runtime-paths.test.ts`
- Create/Modify: `src/main/agent-hooks/runtime-paths.ts`
- Test: `src/main/agent-hooks/runtime-paths.test.ts`

- [ ] **Step 1: Write the failing runtime-path tests**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appPathMocks = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appPathMocks.getPath
  }
}))

describe('agent hook runtime paths', () => {
  beforeEach(() => {
    appPathMocks.getPath.mockImplementation((name) => {
      if (name === 'appData') return 'C:/Users/alice/AppData/Roaming'
      if (name === 'userData') return 'C:/Users/alice/AppData/Roaming/Orca-dev'
      throw new Error(`unexpected path key: ${name}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('derives the global runtime root from appData rather than userData', async () => {
    const paths = await import('./runtime-paths')

    expect(paths.getGlobalAgentHooksDir()).toBe('C:/Users/alice/AppData/Roaming/orca/agent-hooks')
    expect(paths.getGlobalAgentHooksDir()).not.toContain('Orca-dev')
  })

  it('returns stable endpoint and metadata paths under the global runtime root', async () => {
    const paths = await import('./runtime-paths')

    expect(paths.getAgentHookEndpointPath()).toBe(
      'C:/Users/alice/AppData/Roaming/orca/agent-hooks/endpoint.json'
    )
    expect(paths.getAgentHookMetadataPath()).toBe(
      'C:/Users/alice/AppData/Roaming/orca/agent-hooks/runtime.json'
    )
  })
})
```

- [ ] **Step 2: Run the runtime-path test to verify it fails**

Run: `rtk pnpm vitest run src/main/agent-hooks/runtime-paths.test.ts`
Expected: FAIL because `getAgentHookEndpointPath` / `getAgentHookMetadataPath` do not exist yet.

- [ ] **Step 3: Implement the minimal runtime-path module contract**

```ts
import { app } from 'electron'
import { join } from 'node:path'

export function getGlobalAgentHooksDir(): string {
  return join(app.getPath('appData'), 'orca', 'agent-hooks')
}

export function getAgentHookEndpointPath(): string {
  return join(getGlobalAgentHooksDir(), 'endpoint.json')
}

export function getAgentHookMetadataPath(): string {
  return join(getGlobalAgentHooksDir(), 'runtime.json')
}

export function getAgentHookLauncherPath(): string {
  return join(getGlobalAgentHooksDir(), process.platform === 'win32' ? 'launcher.cmd' : 'launcher.sh')
}
```

- [ ] **Step 4: Run the runtime-path test to verify it passes**

Run: `rtk pnpm vitest run src/main/agent-hooks/runtime-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/agent-hooks/runtime-paths.ts src/main/agent-hooks/runtime-paths.test.ts
rtk git commit -m "test: define global agent hook runtime paths"
```

### Task 2: Add shared launcher registration contract tests

**Files:**
- Create: `src/main/agent-hooks/launcher-registration.test.ts`
- Create: `src/main/agent-hooks/launcher-registration.ts`
- Test: `src/main/agent-hooks/launcher-registration.test.ts`

- [ ] **Step 1: Write the failing launcher-registration tests**

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('./runtime-paths', () => ({
  getAgentHookLauncherPath: () => 'C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd'
}))

describe('launcher registration contract', () => {
  it('renders one Windows launcher command shape for all agents', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const { renderManagedHookLauncherCommand } = await import('./launcher-registration')

    expect(renderManagedHookLauncherCommand()).toBe(
      'C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd'
    )
  })

  it('renders one POSIX launcher command shape for all agents', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const { renderManagedHookLauncherCommand } = await import('./launcher-registration')

    expect(renderManagedHookLauncherCommand()).toBe(
      '/bin/sh "C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.cmd"'
    )
  })
})
```

- [ ] **Step 2: Run the launcher-registration test to verify it fails**

Run: `rtk pnpm vitest run src/main/agent-hooks/launcher-registration.test.ts`
Expected: FAIL because `launcher-registration.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal shared registration helper**

```ts
import { getAgentHookLauncherPath } from './runtime-paths'

export function renderManagedHookLauncherCommand(): string {
  const launcherPath = getAgentHookLauncherPath()
  return process.platform === 'win32' ? launcherPath : `/bin/sh "${launcherPath}"`
}
```

- [ ] **Step 4: Run the launcher-registration test to verify it passes**

Run: `rtk pnpm vitest run src/main/agent-hooks/launcher-registration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/agent-hooks/launcher-registration.ts src/main/agent-hooks/launcher-registration.test.ts
rtk git commit -m "test: define shared launcher registration contract"
```

### Task 3: Add endpoint self-discovery and stale-state validation tests

**Files:**
- Create: `src/main/agent-hooks/launcher-runtime.test.ts`
- Create: `src/main/agent-hooks/launcher-runtime.ts`
- Test: `src/main/agent-hooks/launcher-runtime.test.ts`

- [ ] **Step 1: Write the failing launcher-runtime tests**

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('launcher runtime discovery', () => {
  it('loads endpoint coordinates from runtime files without PTY env transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hook-runtime-'))
    writeFileSync(join(root, 'endpoint.json'), JSON.stringify({ url: 'http://127.0.0.1:4312/hook' }))
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
    writeFileSync(join(root, 'endpoint.json'), JSON.stringify({ url: 'http://127.0.0.1:4312/hook' }))
    writeFileSync(
      join(root, 'runtime.json'),
      JSON.stringify({ version: 0, publishedAt: 1234, endpointVersion: 1, publisherPid: 99 })
    )

    const { readHookRuntimeState } = await import('./launcher-runtime')

    expect(() => readHookRuntimeState(root)).toThrow('Unsupported hook runtime metadata version')
  })
})
```

- [ ] **Step 2: Run the launcher-runtime test to verify it fails**

Run: `rtk pnpm vitest run src/main/agent-hooks/launcher-runtime.test.ts`
Expected: FAIL because `launcher-runtime.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal runtime-state reader**

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUPPORTED_RUNTIME_VERSION = 1

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
```

- [ ] **Step 4: Run the launcher-runtime test to verify it passes**

Run: `rtk pnpm vitest run src/main/agent-hooks/launcher-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/agent-hooks/launcher-runtime.ts src/main/agent-hooks/launcher-runtime.test.ts
rtk git commit -m "test: define launcher runtime discovery contract"
```

### Task 4: Migrate hook server publication to global runtime files

**Files:**
- Modify: `src/main/agent-hooks/server.ts`
- Modify: `src/main/agent-hooks/server.test.ts`
- Modify: `src/main/agent-hooks/runtime-paths.ts`
- Test: `src/main/agent-hooks/server.test.ts`

- [ ] **Step 1: Write the failing hook-server publication tests**

Add cases to `src/main/agent-hooks/server.test.ts`:

```ts
it('publishes endpoint state under the global runtime root', async () => {
  const server = new AgentHookServer({
    filesystemProvider,
    runtimeDir: '/tmp/orca-global-hooks',
    userDataPath: '/tmp/orca-user-data'
  })

  await server.start()

  expect(server.endpointFilePath).toBe('/tmp/orca-global-hooks/endpoint.json')
})

it('publishes runtime metadata alongside endpoint state', async () => {
  const server = new AgentHookServer({
    filesystemProvider,
    runtimeDir: '/tmp/orca-global-hooks',
    userDataPath: '/tmp/orca-user-data'
  })

  await server.start()

  const metadata = JSON.parse(await filesystemProvider.readFile('/tmp/orca-global-hooks/runtime.json'))
  expect(metadata.version).toBe(1)
})

it('does not export ORCA_AGENT_HOOK_ENDPOINT into PTY env', async () => {
  const server = new AgentHookServer({
    filesystemProvider,
    runtimeDir: '/tmp/orca-global-hooks',
    userDataPath: '/tmp/orca-user-data'
  })

  await server.start()

  expect(server.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
})
```

- [ ] **Step 2: Run the hook-server tests to verify they fail**

Run: `rtk pnpm vitest run src/main/agent-hooks/server.test.ts`
Expected: FAIL because endpoint publication still uses `userDataPath` and PTY env export still exists.

- [ ] **Step 3: Implement the minimal publication changes**

Update `src/main/agent-hooks/server.ts` so that:

```ts
this.runtimeDir = options.runtimeDir ?? getGlobalAgentHooksDir()
this.endpointFilePathCache = getAgentHookEndpointPath()
this.metadataFilePathCache = getAgentHookMetadataPath()
```

Add metadata publication in the same atomic update path:

```ts
const metadata = {
  version: 1,
  publishedAt: Date.now(),
  endpointVersion: 1,
  publisherPid: process.pid,
  transport: 'http'
}
```

Remove the PTY transport export path:

```ts
buildPtyEnv(): Record<string, string> {
  return {}
}
```

- [ ] **Step 4: Run the hook-server tests to verify they pass**

Run: `rtk pnpm vitest run src/main/agent-hooks/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/agent-hooks/server.ts src/main/agent-hooks/server.test.ts src/main/agent-hooks/runtime-paths.ts
rtk git commit -m "refactor: publish hook runtime state from global runtime root"
```

### Task 5: Migrate managed-entry matcher to launcher registrations

**Files:**
- Modify: `src/main/agent-hooks/installer-utils.ts`
- Modify: `src/main/agent-hooks/installer-utils.test.ts`
- Test: `src/main/agent-hooks/installer-utils.test.ts`

- [ ] **Step 1: Write the failing managed-entry cleanup tests**

Add cases to `src/main/agent-hooks/installer-utils.test.ts`:

```ts
it('matches legacy script registrations and new launcher registrations', () => {
  const match = createManagedCommandMatcher(['claude-hook.sh', 'launcher.sh'])

  expect(match('C:/Users/alice/AppData/Roaming/orca/agent-hooks/claude-hook.sh')).toBe(true)
  expect(match('C:/Users/alice/AppData/Roaming/orca/agent-hooks/launcher.sh')).toBe(true)
})

it('normalizes slash direction before matching launcher registrations', () => {
  const match = createManagedCommandMatcher(['claude-hook.cmd', 'launcher.cmd'])

  expect(match('C:\\Users\\alice\\AppData\\Roaming\\orca\\agent-hooks\\launcher.cmd')).toBe(true)
})
```

- [ ] **Step 2: Run the installer-utils tests to verify they fail**

Run: `rtk pnpm vitest run src/main/agent-hooks/installer-utils.test.ts`
Expected: FAIL because the matcher currently accepts one file name.

- [ ] **Step 3: Implement the minimal matcher expansion**

```ts
export function createManagedCommandMatcher(
  scriptFileNames: string | string[]
): (command: string | undefined) => boolean {
  const needles = (Array.isArray(scriptFileNames) ? scriptFileNames : [scriptFileNames]).map(
    (fileName) => `agent-hooks/${fileName}`
  )

  return (command) => {
    if (!command) return false
    const normalized = command.replaceAll('\\', '/')
    return needles.some((needle) => normalized.includes(needle))
  }
}
```

- [ ] **Step 4: Run the installer-utils tests to verify they pass**

Run: `rtk pnpm vitest run src/main/agent-hooks/installer-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/agent-hooks/installer-utils.ts src/main/agent-hooks/installer-utils.test.ts
rtk git commit -m "refactor: widen managed hook cleanup matching"
```

### Task 6: Migrate all four hook services to the shared launcher contract

**Files:**
- Modify: `src/main/claude/hook-service.ts`
- Modify: `src/main/cursor/hook-service.ts`
- Modify: `src/main/codex/hook-service.ts`
- Modify: `src/main/gemini/hook-service.ts`
- Test: agent hook-service tests if present; otherwise focused install/status tests under each file’s existing coverage

- [ ] **Step 1: Write one failing hook-service regression test per schema shape**

Representative assertions to add near existing hook-service tests:

```ts
expect(installedMatcher.command).toBe(renderManagedHookLauncherCommand())
expect(cursorConfig.hooks[0].command).toBe(renderManagedHookLauncherCommand())
expect(codexConfig.hooks[0].command).toBe(renderManagedHookLauncherCommand())
expect(geminiConfig.hooks[0].command).toBe(renderManagedHookLauncherCommand())
```

And one cleanup assertion:

```ts
expect(updatedConfig.hooks.filter((entry) => entry.command?.includes('agent-hooks')).length).toBe(1)
```

- [ ] **Step 2: Run the hook-service tests to verify they fail**

Run the narrowest existing test targets for each file, for example:
- `rtk pnpm vitest run src/main/claude/hook-service.test.ts`
- `rtk pnpm vitest run src/main/cursor/hook-service.test.ts`
- `rtk pnpm vitest run src/main/codex/hook-service.test.ts`
- `rtk pnpm vitest run src/main/gemini/hook-service.test.ts`

Expected: FAIL because each service still renders its own managed command.

- [ ] **Step 3: Implement the minimal hook-service migration**

Replace per-file command rendering with the shared helper:

```ts
import { renderManagedHookLauncherCommand } from '../agent-hooks/launcher-registration'
```

```ts
function getManagedCommand(): string {
  return renderManagedHookLauncherCommand()
}
```

Update legacy cleanup matcher calls to include both the old script file and the new launcher file where needed.

- [ ] **Step 4: Run the hook-service tests to verify they pass**

Run the same commands from Step 2.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/claude/hook-service.ts src/main/cursor/hook-service.ts src/main/codex/hook-service.ts src/main/gemini/hook-service.ts src/main/agent-hooks/launcher-registration.ts src/main/agent-hooks/installer-utils.ts
rtk git commit -m "refactor: move managed hook registration to shared launcher contract"
```

### Task 7: Rename PTY spawn env fields and add full-env contract tests

**Files:**
- Modify: `src/main/providers/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/terminal-pane/pty-connection.ts`
- Modify: `src/main/ipc/pty.test.ts`
- Test: `src/main/ipc/pty.test.ts`

- [ ] **Step 1: Write the failing PTY env contract tests**

Add cases to `src/main/ipc/pty.test.ts`:

```ts
it('resolves daemon and local PTY env from the same ambient env + overrides contract', async () => {
  const ambientEnv = {
    PATH: 'C:/Windows/System32;C:/Program Files/Git/usr/bin',
    HOME: 'C:/Users/alice'
  }

  const envOverrides = {
    ORCA_TAB_ID: 'tab-1'
  }

  const localEnv = await buildLocalSpawnEnvForTest({ ambientEnv, envOverrides })
  const daemonEnv = await buildDaemonSpawnEnvForTest({ ambientEnv, envOverrides })

  expect(localEnv).toEqual(daemonEnv)
})

it('prepends dev PATH entries after full env resolution rather than replacing PATH', async () => {
  const env = await resolvePtySpawnEnv({
    ambientEnv: { PATH: 'C:/Windows/System32;C:/Program Files/Git/usr/bin' },
    envOverrides: {},
    envToDelete: [],
    isPackaged: false,
    userDataPath: '/tmp/orca-user-data'
  })

  expect(env.PATH).toContain('/tmp/orca-user-data/cli/bin')
  expect(env.PATH).toContain('C:/Windows/System32')
  expect(env.PATH).toContain('C:/Program Files/Git/usr/bin')
})
```

- [ ] **Step 2: Run the PTY tests to verify they fail**

Run: `rtk pnpm vitest run src/main/ipc/pty.test.ts`
Expected: FAIL because the code still uses ambiguous `env` semantics.

- [ ] **Step 3: Implement the minimal type and payload rename**

Update `src/main/providers/types.ts`:

```ts
export type PtySpawnOptions = {
  cols: number
  rows: number
  cwd?: string
  ambientEnv?: Record<string, string>
  envOverrides?: Record<string, string>
  envToDelete?: string[]
  command?: string
  worktreeId?: string
  sessionId?: string
  shellOverride?: string
}
```

Update preload payload shape:

```ts
spawn: (opts: {
  cols: number
  rows: number
  cwd?: string
  ambientEnv?: Record<string, string>
  envOverrides?: Record<string, string>
  command?: string
  worktreeId?: string
  sessionId?: string
  shellOverride?: string
}) => ipcRenderer.invoke('pty:spawn', opts)
```

Update renderer call sites to send `envOverrides` rather than `env`.

- [ ] **Step 4: Run the PTY tests to verify the new tests still fail for the intended reason**

Run: `rtk pnpm vitest run src/main/ipc/pty.test.ts`
Expected: FAIL because resolution logic has not been migrated yet, but payload names compile.

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/providers/types.ts src/preload/index.ts src/renderer/src/components/terminal-pane/pty-connection.ts src/main/ipc/pty.test.ts
rtk git commit -m "refactor: make PTY spawn env inputs explicit"
```

### Task 8: Implement the shared PTY environment resolver in main

**Files:**
- Modify: `src/main/ipc/pty.ts`
- Modify: `src/main/ipc/pty.test.ts`
- Test: `src/main/ipc/pty.test.ts`

- [ ] **Step 1: Write one more failing regression around input immutability**

Add to `src/main/ipc/pty.test.ts`:

```ts
it('does not mutate ambientEnv or envOverrides inputs', async () => {
  const ambientEnv = { PATH: 'C:/Windows/System32' }
  const envOverrides = { ORCA_TAB_ID: 'tab-1' }

  await resolvePtySpawnEnv({
    ambientEnv,
    envOverrides,
    envToDelete: [],
    isPackaged: true,
    userDataPath: '/tmp/orca-user-data'
  })

  expect(ambientEnv).toEqual({ PATH: 'C:/Windows/System32' })
  expect(envOverrides).toEqual({ ORCA_TAB_ID: 'tab-1' })
})
```

- [ ] **Step 2: Run the PTY tests to verify it fails**

Run: `rtk pnpm vitest run src/main/ipc/pty.test.ts`
Expected: FAIL because `resolvePtySpawnEnv` does not exist yet.

- [ ] **Step 3: Implement the minimal full-env resolver**

Add to `src/main/ipc/pty.ts`:

```ts
export function resolvePtySpawnEnv(opts: {
  ambientEnv?: Record<string, string>
  envOverrides?: Record<string, string>
  envToDelete?: string[]
  isPackaged: boolean
  userDataPath: string
}): Record<string, string> {
  const resolvedEnv = {
    ...(opts.ambientEnv ?? process.env),
    ...(opts.envOverrides ?? {})
  }

  for (const key of opts.envToDelete ?? []) {
    delete resolvedEnv[key]
  }

  return applyHostPtyAugmentations(resolvedEnv, {
    isPackaged: opts.isPackaged,
    userDataPath: opts.userDataPath
  })
}
```

Rename the augmentation helper for clarity:

```ts
function applyHostPtyAugmentations(
  env: Record<string, string>,
  opts: { isPackaged: boolean; userDataPath: string }
): Record<string, string> {
  // existing dev PATH prepend and attribution logic
}
```

Update both local and daemon spawn paths to call `resolvePtySpawnEnv(...)` before provider dispatch.

- [ ] **Step 4: Run the PTY tests to verify they pass**

Run: `rtk pnpm vitest run src/main/ipc/pty.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/ipc/pty.ts src/main/ipc/pty.test.ts
rtk git commit -m "refactor: resolve PTY spawn env in main process"
```

### Task 9: Remove host-env repair from local provider and daemon subprocess

**Files:**
- Modify: `src/main/providers/local-pty-provider.ts`
- Modify: `src/main/daemon/pty-subprocess.ts`
- Modify: any focused tests covering provider/subprocess env behavior
- Test: focused provider/daemon tests plus `src/main/ipc/pty.test.ts`

- [ ] **Step 1: Write the failing provider/subprocess contract tests**

Representative assertions:

```ts
it('passes the resolved env through local provider without merging process.env again', async () => {
  expect(spawnEnv).toEqual({ PATH: 'sentinel-path', ORCA_TAB_ID: 'tab-1' })
})

it('passes the resolved env through daemon subprocess without inherited host repair', async () => {
  expect(serializedEnv).toEqual({ PATH: 'sentinel-path', ORCA_TAB_ID: 'tab-1' })
})
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run the smallest existing test targets that exercise these paths, for example:
- `rtk pnpm vitest run src/main/ipc/pty.test.ts`
- `rtk pnpm vitest run src/main/daemon/daemon-pty-provider.test.ts`

Expected: FAIL because provider/subprocess still merge host env.

- [ ] **Step 3: Implement the minimal provider/subprocess contract cleanup**

Change local provider spawn to consume the resolved env directly:

```ts
const env = { ...(args.env ?? {}) }
```

instead of:

```ts
const env = { ...process.env, ...(args.env ?? {}) }
```

Apply the same contract to daemon subprocess serialization / spawn.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run the same commands from Step 2.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/providers/local-pty-provider.ts src/main/daemon/pty-subprocess.ts
rtk git commit -m "refactor: remove PTY provider host env repair"
```

### Task 10: Rewire startup flow to publish runtime before hook installation

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/agent-hooks/server.ts`
- Modify: startup-related tests if present
- Test: hook-server tests plus any startup test coverage available

- [ ] **Step 1: Write the failing startup-order assertion**

Representative test logic:

```ts
it('publishes hook runtime state before refreshing managed hook config', async () => {
  const calls: string[] = []

  mockStartHookServer.mockImplementation(async () => {
    calls.push('start-server')
  })
  mockInstallHooks.mockImplementation(async () => {
    calls.push('install-hooks')
  })

  await initializeMainProcessForTest()

  expect(calls).toEqual(['start-server', 'install-hooks'])
})
```

- [ ] **Step 2: Run the startup-related tests to verify they fail**

Run the narrowest relevant startup test target, or if none exists yet, run:
- `rtk pnpm vitest run src/main/agent-hooks/server.test.ts`
- `rtk pnpm vitest run src/main/index.test.ts`

Expected: FAIL because startup order is still coupled to mixed runtime publication.

- [ ] **Step 3: Implement the minimal startup reordering**

In `src/main/index.ts`, make the hook startup path follow:

```ts
const hookServer = await startAgentHookServer()
await hookServer.publishRuntimeState()
await refreshManagedHookConfigs()
```

Remove remaining writes to `userData/agent-hooks` transport files.

- [ ] **Step 4: Run the startup-related tests to verify they pass**

Run the same commands from Step 2.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main/index.ts src/main/agent-hooks/server.ts
rtk git commit -m "refactor: align hook startup with global runtime publication"
```

### Task 11: Run contract-level regression suite

**Files:**
- Test only

- [ ] **Step 1: Run focused hook-runtime tests**

Run: `rtk pnpm vitest run src/main/agent-hooks/runtime-paths.test.ts src/main/agent-hooks/launcher-registration.test.ts src/main/agent-hooks/launcher-runtime.test.ts src/main/agent-hooks/server.test.ts src/main/agent-hooks/installer-utils.test.ts`
Expected: PASS

- [ ] **Step 2: Run PTY contract tests**

Run: `rtk pnpm vitest run src/main/ipc/pty.test.ts`
Expected: PASS

- [ ] **Step 3: Run project typecheck**

Run: `rtk pnpm run typecheck`
Expected: PASS

- [ ] **Step 4: Run project build if typecheck is green**

Run: `rtk pnpm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/main src/preload src/renderer docs/superpowers/specs/2026-05-01-managed-hook-runtime-and-pty-env-unification-design.md docs/superpowers/plans/2026-05-01-managed-hook-runtime-and-pty-env-unification-implementation-plan.md
rtk git commit -m "refactor: unify hook runtime and PTY env contracts"
```

### Task 12: Verify Windows behavior manually in dev and release flows

**Files:**
- No source edits required unless a verified regression is found

- [ ] **Step 1: Start the dev build and verify hook runtime publication**

Run: `rtk pnpm run dev`
Expected: the app starts and publishes runtime files under the global `agent-hooks` root.

- [ ] **Step 2: Exercise a terminal in the dev build**

Verification checklist:
- new terminal starts successfully;
- managed hooks execute without `command not found`;
- runtime files resolve from the global runtime root;
- `ORCA_AGENT_HOOK_ENDPOINT` is not required in PTY env.

- [ ] **Step 3: Stop dev, start the packaged/release build, and repeat**

Run the project’s normal packaged app start flow available in the environment.
Expected: release picks up the same global hook runtime root rather than a stale dev-private path.

- [ ] **Step 4: Switch back to dev and verify handoff again**

Verification checklist:
- dev/release alternation only repoints the active runtime publisher;
- hook config does not accumulate duplicate managed entries;
- new terminals still execute hooks successfully.

- [ ] **Step 5: Record any platform-specific follow-up as a separate plan item, not an inline scope expansion**

If manual verification reveals a new issue, stop and open a new scoped task instead of extending this plan ad hoc.

---

## Final verification checklist

- [ ] All runtime path tests pass
- [ ] Shared launcher contract tests pass
- [ ] Endpoint self-discovery and stale-state validation tests pass
- [ ] Hook services all register the same launcher contract
- [ ] PTY local and daemon paths resolve env through one pipeline
- [ ] Provider/subprocess layers no longer merge `process.env`
- [ ] Typecheck passes
- [ ] Build passes
- [ ] Manual dev/release switching on Windows no longer corrupts managed hook execution
