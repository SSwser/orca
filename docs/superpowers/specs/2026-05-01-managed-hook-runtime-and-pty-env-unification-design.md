# Managed Hook Runtime and PTY Environment Unification

## Background

The current implementation exposes three coupled classes of problems:

1. Managed hook commands are generated independently by agent-specific services:
   - `src/main/claude/hook-service.ts`
   - `src/main/cursor/hook-service.ts`
   - `src/main/codex/hook-service.ts`
   - `src/main/gemini/hook-service.ts`

   Each file currently carries part of the responsibility for platform command rendering, path formatting, and shell compatibility. This makes Windows behavior dependent on repeated string-construction logic spread across business-layer files.

2. PTY environment semantics are not singular:
   - caller-provided environment overrides and the host's full environment are mixed across layers;
   - daemon and local PTY paths do not resolve environment state in the same way;
   - host augmentations such as dev-mode injections, PATH prepends, and attribution shims can run against partial environment state.

3. Hook configuration scope and runtime scope are misaligned:
   - hook configuration is global;
   - hook scripts, endpoint files, and runtime transport state are currently tied to build-specific `userData` directories.

   This allows dev and release builds to share configuration while pointing at different runtime roots, producing stale paths, invalid hook references, and cross-build contamination.

This design treats the above as one system problem rather than three isolated defects.

## Goals

### Primary goals

1. Establish a single platform execution contract for all managed hooks.
2. Establish a single environment resolution contract for PTY spawn.
3. Establish a single global runtime scope contract for managed hook infrastructure.
4. Eliminate recurring compatibility failures caused by shell differences, path-format differences, and dev/release runtime divergence.
5. Concentrate platform compatibility rules inside shared infrastructure rather than duplicating them across agent-specific services.

### Non-goals

1. Preserve the current per-build runtime directory model.
2. Retain long-term compatibility paths for legacy command-string shapes.
3. Continue using a mixed transport model where some hook transport state flows via PTY env and some via endpoint files.
4. Leave platform command rendering under ownership of agent-specific hook services.

## Design principles

1. **Single source of truth**
   - platform command rendering has one owner;
   - PTY full-environment resolution has one owner;
   - managed hook runtime root has one owner.

2. **Scope alignment**
   - global configuration must point to a global runtime;
   - terminal-local state must stay in PTY env;
   - hook transport discovery must not depend on PTY env.

3. **Layer ownership**
   - hook-service registers hooks;
   - launcher executes hooks;
   - hook server publishes endpoint state;
   - PTY layer supplies terminal context;
   - provider/subprocess layers consume already-resolved full env.

4. **Platform isolation**
   - platform-specific shell and path behavior must be centralized in shared launcher or rendering layers;
   - business services must not directly handle Windows quoting, shell-safe path normalization, or launcher selection.

## Recommended architecture

The target architecture introduces four aligned building blocks:

1. A **global managed hook runtime root**
2. A **stable launcher-only hook registration model**
3. **Endpoint self-discovery** by launchers
4. A **single PTY environment resolution pipeline**

### High-level structure

#### Business layer

Agent-specific services remain responsible only for:
- config file locations;
- agent event lists;
- config schema mapping;
- install/remove/status lifecycle.

They no longer own platform command rendering.

#### Platform execution layer

A managed hook launcher becomes the only component responsible for:
- launcher entrypoint behavior;
- endpoint self-discovery;
- platform-specific command execution details;
- dispatching hook invocations toward the active runtime.

#### Runtime publication layer

The hook server is responsible for:
- starting the server;
- writing endpoint files;
- publishing runtime metadata atomically.

#### Terminal environment layer

A dedicated PTY environment resolver is responsible for:
- combining ambient full environment with caller overrides;
- applying deletions;
- applying host augmentations;
- returning a fully resolved spawn-ready env.

## Runtime scope design

### Global runtime root

Introduce a shared path module under `src/main/agent-hooks/runtime-paths.ts`.

This module must define:
- global runtime root;
- launcher path;
- endpoint file path;
- runtime metadata file path;
- any agent-specific generated script paths that remain necessary during migration.

### Runtime root selection policy

The global runtime root must be chosen by one explicit policy:

1. it is user-scoped rather than build-scoped;
2. it is independent of Electron `userData`;
3. dev and release builds resolve exactly the same root;
4. the root is derived from the same OS-level roaming/application-data base used for global hook configuration;
5. all hook-runtime consumers obtain paths only through `runtime-paths.ts`.

In the current repository, `getGlobalAgentHooksDir()` already establishes the appropriate root under the user's app-data namespace. The migration extends that root from “shared script directory” into the single owner of launcher, endpoint, and metadata state.

### Runtime ownership

The running Orca instance owns the active runtime publication state.

The last instance that successfully initializes the hook server becomes the active publisher of:
- endpoint file contents;
- current runtime metadata.

This is not treated as cross-build interference. It is the defined ownership model for a global hook system.

### Runtime invariants

1. Multi-instance startup must update endpoint state atomically.
2. Launchers must always resolve the latest endpoint file rather than caching build-specific paths.
3. Shutting down one build must not leave global configuration pointing at its private directories.

## Hook execution design

### Stable launcher-only registration

Hook configuration must register a stable launcher command, not a build-specific script path.

Agent-specific services must no longer generate platform-aware command strings on their own. Their responsibility ends at selecting the appropriate launcher registration contract for their config schema.

### Registration contract vs rendering internals

The shared execution boundary must be split into two explicit responsibilities:

1. **Registration contract helper**
   - returns the command shape that must be written into each agent's config schema;
   - knows schema-facing differences such as plain string vs structured record;
   - does not embed transport metadata;
   - does not let agent services reimplement platform rendering.

2. **Launcher execution internals**
   - perform endpoint self-discovery;
   - validate runtime metadata;
   - normalize platform-specific execution behavior;
   - dispatch the hook call to the active server.

This separation prevents business services from regaining ownership over quoting, path normalization, or interpreter selection while still allowing each config schema to be written correctly.

### Single shared launcher shape

All managed hook registrations must point to one shared launcher entrypoint shape.

The launcher contract must satisfy:
- one conceptual executable surface for all four agent integrations;
- one shared argument model for passing agent and event identity;
- one platform-specific renderer owned by the shared launcher layer;
- no per-agent divergence in `.cmd` vs `.sh` command construction.

Different agent schemas may still serialize that contract differently, but they must all map to the same launcher semantics.

### Launcher responsibilities

The launcher is responsible for:
1. identifying the current agent/event context;
2. locating the global runtime root;
3. resolving endpoint data from the runtime root;
4. reading runtime metadata;
5. validating that the discovered runtime is current and structurally valid;
6. communicating with the active hook server;
7. handling all platform-specific execution differences.

### Platform boundary

Windows-specific shell behavior and POSIX-specific shell behavior must exist only in this shared execution layer.

Agent-specific hook services must no longer contain:
- `.cmd` vs `.sh` selection logic;
- shell-safe path conversion logic;
- quoting logic;
- direct launcher command rendering.

### Agent service responsibilities after refactor

The following files remain, but with narrower scope:
- `src/main/claude/hook-service.ts`
- `src/main/cursor/hook-service.ts`
- `src/main/codex/hook-service.ts`
- `src/main/gemini/hook-service.ts`

They are responsible for:
1. locating config files;
2. mapping agent events into each config schema;
3. install/remove/status lifecycle;
4. registering the shared launcher command.

They are not responsible for platform execution details.

## Hook transport design

### Endpoint self-discovery

Launchers must discover transport coordinates from the global runtime root rather than from PTY environment variables.

The launcher flow is:
1. locate runtime root;
2. read endpoint file from that root;
3. read runtime metadata from the same root;
4. validate the published state;
5. connect to the active runtime.

### Runtime metadata and stale-state validation

Endpoint publication must include explicit metadata sufficient to reject stale or incompatible state.

The metadata contract must include:
- runtime format version;
- publisher process identity or equivalent instance marker;
- publication timestamp;
- transport kind;
- endpoint file version or monotonic freshness marker.

The launcher must treat endpoint discovery as successful only when:
1. endpoint file exists;
2. endpoint file is parseable;
3. metadata file exists and is parseable;
4. metadata version matches the launcher's supported contract;
5. metadata freshness and endpoint payload are mutually consistent.

This prevents a newly started build from consuming transport state published by an obsolete layout or half-written takeover.

### Resulting transport model

This removes hook transport dependence on:
- endpoint path env vars;
- port env vars;
- token env vars;
- stale PTY state left behind by previous terminal sessions.

### PTY env contents after refactor

PTY env should retain only terminal-scoped identifiers such as:
- `ORCA_PANE_KEY`
- `ORCA_TAB_ID`
- `ORCA_WORKTREE_ID`

PTY env should no longer carry hook transport coordinates.

## PTY environment design

### Explicit environment categories

Introduce unambiguous categories:
- **ambientEnv**: the host's complete baseline environment, typically derived from `process.env`;
- **envOverrides**: caller-provided partial overrides;
- **envToDelete**: explicit deletions or equivalent removal semantics.

A single ambiguous `env` field must no longer carry multiple meanings.

### Single environment resolution pipeline

Introduce one authoritative environment resolver in the main process, for example:
- `resolvePtySpawnEnv(...)`

Its fixed order of operations must be:
1. create a full baseline from ambientEnv;
2. apply envOverrides;
3. apply deletions;
4. apply host augmentations;
5. return the final spawn-ready environment.

### PTY resolution constraints

1. Host augmentations run only against a complete resolved environment.
2. Local and daemon PTY paths must use the same resolution pipeline.
3. Provider and subprocess layers must not merge `process.env` again.
4. No helper may implicitly assume the caller supplied a complete env.

### Host augmentations

The following behaviors remain valid, but must apply only after full resolution:
- dev-mode `ORCA_USER_DATA_PATH` injection;
- dev CLI PATH prepend;
- terminal attribution shim PATH prepend;
- any additional tool-specific augmentation such as OpenCode, Codex, or Pi integration.

These augmentations enhance a complete environment; they do not repair a partial one.

## Provider and subprocess contract

### Local provider

`src/main/providers/local-pty-provider.ts` must satisfy:
- input env is already complete and final;
- it no longer performs `{ ...process.env, ...args.env }`-style merges;
- it only handles shell selection, dimensions, and spawn behavior.

### Daemon subprocess

`src/main/daemon/pty-subprocess.ts` must satisfy:
- the received env is already complete;
- it no longer relies on inherited host state to compensate for upstream ambiguity;
- it obeys the same environment contract as the local provider.

## Managed entry migration and cleanup

### Legacy managed entry cleanup strategy

Installation must aggressively converge existing global configs onto the new launcher contract.

The cleanup contract must:
1. identify prior managed entries by stable managed markers rather than exact command-string equality;
2. normalize slash direction and path formatting before managed-entry matching;
3. remove old build-specific script registrations during install;
4. deduplicate multiple managed entries down to one current launcher registration;
5. avoid deleting user-authored unmanaged entries.

`createManagedCommandMatcher(...)` already provides the correct direction for path-based managed entry identification. The migration should extend that matcher strategy to cover prior script-based registrations and new launcher-based registrations under one normalization rule.

This is the only migration accommodation required. The runtime does not retain a fallback execution path for obsolete command shapes.

## Startup and lifecycle design

`src/main/index.ts` must be reorganized to:
1. initialize global runtime paths;
2. start the hook server;
3. atomically publish endpoint state and runtime metadata;
4. install or refresh launcher registration in agent configs;
5. stop writing transport entrypoints into build-specific `userData/agent-hooks` paths.

### Lifecycle invariants

1. Global hook config always points to a stable launcher.
2. The launcher always resolves endpoint state from the global runtime root.
3. The current Orca instance publishes the active endpoint state.
4. Dev/release switching does not require rewriting config to different private runtime locations.

## Failure handling

### Fail-open behavior

If hook runtime initialization fails:
- the main app must still start;
- status reporting must remain explicit;
- partially invalid runtime state must not be written as the active global configuration.

### Atomic updates

The following must be updated atomically:
- endpoint file;
- runtime metadata file;
- hook config files, where current infrastructure allows.

This prevents launchers from observing half-written state during startup or multi-instance takeover.

### Invalid runtime detection

The launcher must explicitly detect and fail on:
- missing endpoint file;
- invalid endpoint file format;
- missing metadata file;
- invalid metadata file format;
- runtime metadata mismatch;
- unreachable hook server.

It must not recover via PTY env-based transport fallback.

## Testing strategy

### Shared contract tests

Add focused tests for:

#### Runtime paths
- dev and release produce the same runtime root;
- launcher, endpoint, and metadata paths are stable and predictable;
- the chosen root remains independent of `userData`.

#### Launcher registration contract
- platform registration rendering is tested once at the shared launcher-registration layer;
- agent-specific services only verify schema mapping to the shared launcher contract;
- Windows command contracts and POSIX command contracts are explicit.

#### Endpoint self-discovery
- a launcher can locate endpoint state from runtime root alone;
- no PTY env transport variables are required;
- stale metadata is rejected deterministically.

### PTY environment contract tests

Extend `src/main/ipc/pty.test.ts` to verify:
1. identical ambientEnv + overrides yield equivalent local/daemon results;
2. dev augmentations occur only after full resolution;
3. PATH prepends use resolved full PATH rather than partial caller state;
4. helper functions do not mutate input objects;
5. provider/subprocess layers no longer merge `process.env`.

### Hook service tests

Agent service tests should validate:
1. registration of the shared launcher command;
2. correct schema output per agent;
3. cleanup of old managed entries;
4. absence of build-specific runtime path dependence.

They should not retest platform execution details.

### Black-box regression tests

Add higher-level regression coverage for:
1. shell/path boundary behavior on Windows;
2. dev/release switching while launchers continue to resolve the active endpoint;
3. stale PTY state not affecting hook transport;
4. multi-instance handoff preserving active endpoint correctness.

## TDD implementation strategy

Implementation should proceed test-first in this order:
1. runtime path contract tests;
2. launcher registration/rendering contract tests;
3. endpoint self-discovery and stale-state validation tests;
4. PTY full-environment resolution tests;
5. service migration to the shared contracts.

### TDD rule

Shared boundaries must be specified in failing tests before business-layer callers are migrated. This keeps the refactor driven by explicit contracts instead of incremental behavioral drift.

## Migration strategy

This migration should directly converge on the target architecture rather than preserving the existing split-scope model.

### Suggested sequence

1. Extend `runtime-paths.ts` into the single source of runtime root, launcher, endpoint, and metadata paths.
2. Introduce the shared launcher registration contract and shared launcher execution shape.
3. Move hook server endpoint and metadata publication to the global runtime root.
4. Update all four hook services to register the shared launcher.
5. Remove PTY env transport injection for hook transport data.
6. Introduce the full PTY environment resolver.
7. Remove provider/subprocess-side `process.env` merges.
8. Delete obsolete comments and dual-semantics logic.

### Cutover criteria

After migration:
1. hook config no longer references build-specific `userData` runtime paths;
2. hook transport no longer depends on PTY env;
3. local and daemon PTY paths obey the same environment contract;
4. agent services no longer own platform command rendering;
5. platform compatibility rules live only in shared execution and env-resolution layers.

## Impacted files

### Core
- `src/main/index.ts`
- `src/main/agent-hooks/server.ts`
- `src/main/agent-hooks/runtime-paths.ts`
- launcher contract / execution modules under `src/main/agent-hooks/`
- `src/main/ipc/pty.ts`
- `src/main/providers/local-pty-provider.ts`
- `src/main/daemon/pty-subprocess.ts`

### Agent services
- `src/main/claude/hook-service.ts`
- `src/main/cursor/hook-service.ts`
- `src/main/codex/hook-service.ts`
- `src/main/gemini/hook-service.ts`

### Renderer and shared types
- `src/preload/index.ts`
- `src/renderer/src/components/terminal-pane/pty-connection.ts`
- PTY spawn shared type definitions in `src/main/providers/types.ts`

### Tests
- `src/main/ipc/pty.test.ts`
- `src/main/agent-hooks/server.test.ts`
- `src/main/agent-hooks/installer-utils.test.ts`
- hook-service-related tests
- new launcher/runtime-paths/endpoint self-discovery tests

## Success criteria

This design is considered satisfied when all of the following are true:
1. Windows hook execution no longer depends on agent-specific services constructing platform command strings;
2. dev/release switching does not cause global hook config to reference invalid runtime paths;
3. PTY env semantics are identical across local and daemon paths;
4. hook transport no longer depends on PTY env;
5. platform compatibility rules are concentrated in shared execution and env-resolution layers;
6. regression coverage for this class of issues lives at shared contract boundaries rather than being scattered across business services.
