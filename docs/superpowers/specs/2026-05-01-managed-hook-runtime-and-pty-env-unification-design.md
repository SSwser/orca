# Managed Hook Runtime and PTY Environment Unification

## Background

This branch addresses one cross-layer problem with two visible symptoms:

1. Managed hook execution had too many owners.
   - agent-specific services each carried parts of command rendering and managed-entry behavior;
   - launcher registration, cleanup, endpoint publication, and runtime discovery were drifting apart;
   - Windows compatibility depended on repeated command-shape logic spread across multiple files.

2. PTY startup and hook transport had mixed responsibilities.
   - PTY environment shaping and hook runtime discovery were partially coupled;
   - some layers still behaved as if transport state might need to flow through PTY env;
   - provider-side repair logic made ownership harder to reason about.

A design mistake also emerged during the work: moving managed hook runtime state into one shared cross-build root would violate Orca's dogfood model. Orca is used to develop Orca, so dev and packaged installs must not silently share mutable runtime state.

This spec records the corrected design direction that matches the current implementation on this branch.

## Goals

### Primary goals

1. Establish one shared launcher contract for managed hooks across Claude, Codex, Cursor, and Gemini.
2. Publish hook runtime state through one shared runtime-path layer.
3. Keep managed hook runtime state isolated by the active build/runtime namespace.
4. Remove hook transport dependence on PTY environment variables.
5. Resolve PTY spawn environment in main before provider-specific spawn paths run.
6. Centralize platform-specific hook execution behavior in shared infrastructure rather than agent-specific business services.

### Non-goals

1. Introduce a single global runtime root shared by dev and packaged installs.
2. Preserve long-term fallback for obsolete managed command shapes.
3. Keep dual transport models where hook coordinates may come from either runtime files or PTY env.
4. Re-expand agent-specific hook services to own platform quoting, shell selection, or launcher rendering.

## Design principles

1. **Dogfood-safe isolation**
   - dev and packaged Orca installs must not publish runtime files into the same mutable directory;
   - runtime files must follow the active `userData` namespace (`orca` vs `orca-dev` on Windows);
   - global hook config may be shared, but the runtime state it points at must reflect the currently active build.

2. **Single owner per concern**
   - runtime paths come from `src/main/agent-hooks/runtime-paths.ts`;
   - managed hook registration comes from the shared launcher contract;
   - endpoint publication comes from the hook server;
   - PTY spawn env is resolved in main before local or daemon providers consume it.

3. **Launcher-driven discovery**
   - launchers discover endpoint state from runtime files on disk;
   - hook transport must not depend on PTY env injection;
   - business services should register the launcher contract, not reconstruct transport details.

4. **Platform logic belongs in shared infrastructure**
   - Windows and POSIX command behavior must be centralized;
   - agent services should not independently own shell quoting or command-shape rendering.

## Recommended architecture

The branch architecture is organized around four aligned building blocks:

1. a **build-scoped managed hook runtime root**
2. a **shared launcher registration contract**
3. **endpoint self-discovery from runtime files**
4. a **single PTY spawn-environment resolution pipeline in main**

### High-level structure

#### Business layer

Agent-specific services remain responsible for:
- locating each tool's config files;
- mapping Orca events into each config schema;
- install/remove/status lifecycle;
- using the shared launcher registration contract.

They do not own runtime-root policy or PTY transport policy.

#### Shared launcher layer

The shared launcher boundary owns:
- the managed command shape written into agent configs;
- platform-specific launcher selection;
- endpoint self-discovery from runtime files;
- dispatch toward the active hook server.

#### Runtime publication layer

The hook server owns:
- starting the server;
- publishing endpoint state;
- publishing runtime metadata;
- doing so under the active runtime root.

#### PTY environment layer

Main-process PTY startup owns:
- combining baseline environment and caller overrides;
- applying deletions;
- applying host augmentations;
- passing a fully resolved env into local or daemon provider paths.

## Runtime scope design

### Build-scoped runtime root

`src/main/agent-hooks/runtime-paths.ts` is the single source of truth for managed hook runtime paths.

It defines:
- runtime root;
- launcher path;
- endpoint file path;
- runtime metadata path.

The active runtime root must be derived from the current `userData` namespace, not from a hard-coded shared `appData/orca` directory.

### Runtime root selection policy

The runtime root must follow these rules:

1. it is user-scoped and build-scoped;
2. it remains anchored under the OS app-data base;
3. the final namespace comes from the active `userData` directory name;
4. dev and packaged installs therefore publish into different runtime roots;
5. all managed hook runtime consumers obtain paths only through `runtime-paths.ts`.

On Windows this means dev and packaged installs naturally separate into roots such as:
- `%APPDATA%/orca-dev/agent-hooks`
- `%APPDATA%/orca/agent-hooks`

This preserves the repository's existing isolation contract instead of inventing a new shared root.

### Runtime ownership

The currently running Orca instance owns publication inside its own runtime root.

That instance publishes:
- `endpoint.json`
- `runtime.json`
- the launcher path registered for managed hooks

The important rule is not “one global publisher wins across all builds,” but “each build publishes state into its own isolated runtime boundary.”

### Runtime invariants

1. Endpoint and metadata publication must be atomic enough that launchers do not observe half-written state.
2. Launchers must resolve endpoint state from the active runtime root.
3. Dev startup must not overwrite packaged runtime files, and packaged startup must not overwrite dev runtime files.

## Hook execution design

### Shared launcher-only registration

Managed hook installation should converge on one shared launcher contract across supported agents.

Agent-specific services should no longer each define their own long-term platform command policy. Their responsibility is to map their schema onto the shared launcher contract.

### Registration contract vs execution internals

The shared boundary is intentionally split into two responsibilities:

1. **Registration contract**
   - returns the command form that must be written into each agent's config schema;
   - hides schema-facing differences without reintroducing per-agent platform logic.

2. **Launcher execution internals**
   - locate runtime files;
   - discover endpoint state;
   - validate runtime metadata;
   - dispatch hook calls toward the active hook server.

This keeps business services small while preventing launcher behavior from fragmenting again.

### Launcher responsibilities

The launcher is responsible for:
1. identifying the current agent/event context;
2. locating the active runtime root;
3. reading endpoint data from that root;
4. reading runtime metadata from the same root;
5. validating the discovered state;
6. communicating with the active hook server;
7. handling platform-specific execution differences.

## Hook transport design

### Endpoint self-discovery

Launchers discover transport coordinates from runtime files rather than from PTY env variables.

The launcher flow is:
1. locate runtime root;
2. read `endpoint.json`;
3. read `runtime.json`;
4. validate the published state;
5. connect to the active runtime.

### Runtime metadata and validation

Runtime metadata must be sufficient for launchers to reject invalid or stale state.

The metadata contract should include fields such as:
- runtime format version;
- publisher process identity or equivalent instance marker;
- publication timestamp;
- transport kind.

The launcher should treat discovery as successful only when endpoint and metadata state are both present and structurally valid.

### PTY env contents after refactor

PTY env may still carry terminal-scoped identifiers such as:
- `ORCA_PANE_KEY`
- `ORCA_TAB_ID`
- `ORCA_WORKTREE_ID`

PTY env should not carry hook transport coordinates.

## PTY environment design

### Explicit environment categories

PTY startup should use explicit categories:
- **ambientEnv**: the baseline host environment;
- **envOverrides**: caller-provided overrides;
- **envToDelete**: explicit removals.

One ambiguous `env` field should not continue to carry multiple meanings.

### Single resolution pipeline

Main-process PTY startup should resolve one spawn-ready environment in a fixed order:
1. start from ambientEnv;
2. apply envOverrides;
3. apply deletions;
4. apply host augmentations;
5. pass the final env to the local or daemon path.

### Resolution constraints

1. Host augmentations must run against a complete resolved environment.
2. Local and daemon PTY paths must use the same resolution pipeline.
3. Provider and subprocess layers must not repair missing host env by silently merging `process.env` again.

### Host augmentations

The following remain valid, but only after full resolution:
- dev-mode `ORCA_USER_DATA_PATH` injection;
- dev CLI PATH prepend;
- attribution/tooling PATH adjustments.

These augmentations enhance a complete environment; they do not compensate for an ambiguous upstream contract.

## Managed entry migration and cleanup

Installation should aggressively converge existing managed entries onto the shared launcher contract.

Cleanup should:
1. identify prior managed entries by stable managed markers rather than exact string equality;
2. normalize slash direction before matching;
3. remove old managed script registrations during install;
4. deduplicate multiple managed entries down to one current launcher registration;
5. avoid deleting user-authored unmanaged entries.

This branch preserves the migration direction of widening managed-entry cleanup, but it does not preserve old command shapes as a long-term parallel runtime model.

## Startup and lifecycle design

Startup should follow this ownership order:
1. resolve runtime paths;
2. start the hook server;
3. publish endpoint and metadata state under the active runtime root;
4. install or refresh managed hook registrations.

### Lifecycle invariants

1. Managed hook config points at the shared launcher contract.
2. The launcher resolves endpoint state from the active runtime root.
3. Runtime publication stays inside the active build's isolated namespace.
4. Dev/release switching must not redirect runtime publication into each other's directories.

## Failure handling

### Fail-open behavior

If hook runtime initialization fails:
- the main app should still start;
- status reporting should remain explicit;
- partially invalid runtime state must not be published as healthy state.

### Invalid runtime detection

The launcher should explicitly fail on:
- missing endpoint file;
- invalid endpoint file format;
- missing metadata file;
- invalid metadata file format;
- metadata mismatch;
- unreachable hook server.

It should not recover by falling back to PTY-env-based transport coordinates.

## Testing strategy

### Shared contract tests

Add or maintain focused tests for:

#### Runtime paths
- packaged and dev builds resolve different runtime roots based on the active `userData` namespace;
- launcher, endpoint, and metadata paths stay under that active runtime root;
- runtime paths stay anchored under the OS app-data base rather than nested Electron implementation paths.

#### Launcher registration contract
- platform registration rendering is tested once at the shared launcher-registration layer;
- agent-specific services verify schema mapping to the shared launcher contract;
- managed-entry cleanup covers both legacy script registrations and launcher registrations.

#### Endpoint self-discovery
- launchers can locate endpoint state from runtime files alone;
- no PTY env transport variables are required;
- invalid metadata is rejected deterministically.

### PTY environment contract tests

Extend PTY coverage to verify:
1. identical ambientEnv + overrides yield equivalent local/daemon results;
2. dev augmentations occur only after full resolution;
3. PATH prepends preserve the resolved baseline PATH;
4. helper functions do not mutate inputs;
5. provider/subprocess layers do not re-merge host env.

### Hook service tests

Agent service tests should validate:
1. registration of the shared launcher contract;
2. correct schema output per agent;
3. cleanup of old managed entries;
4. absence of runtime-path policy duplicated in business services.

They should not retest shared launcher internals.

### Manual Windows verification

Manual verification remains important for this design because the risk crosses Electron path resolution, launcher execution, and real Windows runtime directories.

The key checks are:
1. clearing `orca-dev` and launching dev recreates runtime state under `orca-dev`;
2. dev launch does not republish runtime state into packaged `orca`;
3. managed hooks continue to execute after PTY transport decoupling.

## Success criteria

This design is satisfied when all of the following are true:
1. managed hook runtime state follows the active build/runtime namespace instead of a shared cross-build root;
2. managed hooks across supported agents register through one shared launcher contract;
3. hook transport no longer depends on PTY env;
4. PTY local and daemon paths obey the same environment-resolution contract;
5. provider-side env repair no longer hides ownership ambiguity;
6. Windows dev/package switching no longer corrupts managed hook runtime state.
