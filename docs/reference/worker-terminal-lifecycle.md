# Worker execution-resource lifecycle

Orca must account for every supervised Worker execution resource without guessing whether its execution ended. This contract separates execution-host evidence, resource custody, archived business output, Delivery progress, physical workspace generations, and capacity accounting. Terminal is the first production adapter; adding another resource kind must not create another Worker lifecycle owner.

## Scope and ownership

`WorkerExecutionResource` is the Worker control plane's provider-neutral custody record. It binds one Dispatch and owner generation to a resource kind, an exact execution-host authority reference, an archive reference, lifecycle state, and stable release operation/receipt. The Worker control plane owns capacity, containment, successor generation, Delivery, and Task settlement.

The execution host owns the facts and actions behind the authority reference. For a Terminal-backed Agent Session, the Terminal adapter owns exact PTY/process custody while the Agent Session execution owner owns provider session identity, writer fencing, turn acceptance, and provider history. Worker persistence records only the opaque authority and receipts needed to settle custody; it never copies either adapter's internal lifecycle.

Terminal is the first production custody adapter. A non-Terminal Agent Session adapter is admitted only after one execution-host owner implements exact writer status, generation fencing, stop/release, restart inspection, and receipt readback. Cross-Agent identity and continuation contracts remain outside the Worker business model even when their Session reference and WriteFence participate in execution admission.

The target schema and runtime route replace terminal-only lifecycle authority directly. There is no legacy runtime route, dual read/write, shadow state, fallback adapter, or selectable transition mode. Remote mixed-version safety is capability admission: an unsupported peer fails before mutation rather than running an older custody path.

## Authority and evidence

The execution host owns liveness evidence and execution actions. For Terminal, a handle, inventory entry, connection, writable transport, PID, ancestry, command line, or stale runtime identity is not custody. Exact custody comes from the execution host's current PTY/Job owner and recorded process incarnation.

Resource liveness has exactly three verdicts: `live`, `unverifiable`, and `exited`. Only positive evidence from the execution host establishes `exited`. Missing inventory, lost transport, permission failure, daemon restart, and identity ambiguity are `unverifiable`.

A provider-observed PTY exit is positive evidence that the exact PTY root exited, but its code does not invent an initiator. A negative or unknown exit code with no correlated stop operation is an unexpected exit with unknown reason. `stop_unverified` is reserved for an explicit stop operation whose exact process-tree exit could not be confirmed; it must carry that operation identity. A disconnected renderer or transport is never an exit receipt.

An empty process list is not positive exit evidence for SSH or a paired runtime. The execution host must return an identity-bearing verdict for the recorded process incarnation under a negotiated capability. A client-side classifier may confirm `live` from an exact match, but it must not convert remote absence into `exited`. For a local supervised worker, an exact probe proving that the recorded old daemon process incarnation is gone can establish `exited`; access denial, transport loss, or ambiguous identity cannot.

Never reconstruct custody from PID, ancestry, command line, terminal ID, or proximity. Never use broad termination to reconcile a worker resource.

### Execution binding and renderer surface

A terminal handle resolves one stable execution binding: runtime identity, execution host, PTY id, and PTY/Session incarnation. Tab id, leaf id, renderer graph epoch, and pane generation are a separate surface projection. Mounting, revealing, reloading, or adopting a renderer pane may update that projection, but it cannot change the execution binding or select a different transport owner.

Durable execution operations resolve the binding directly. A `pty:` presentation marker, current tab mount, leaf writability, or graph membership is not capability evidence. Renderer state may reject a stale UI surface, but it cannot redirect a durable operation through ordinary terminal input. Headless and visible projections of the same exact PTY therefore reach the same execution-host owner.

### Windows containment capability

The lifecycle and fail-closed evidence rules are cross-platform. Native Windows adds two Job Object guarantees for supervised workers:

1. the per-PTY Job owns explicit teardown of one terminal process tree; and
2. the daemon host Job contains all supervised PTYs if that daemon process exits unexpectedly.

These owners are complementary. Terminating a per-PTY Job can prove that one owned tree ended even when ConPTY never publishes its JavaScript exit callback. The daemon host Job prevents future supervised workers from surviving the loss of their custody owner. Neither Job authorizes a restarted daemon to adopt a legacy PID or terminal.

The exact daemon-crash guarantee is available only for native Windows supervised workers created by a daemon at or above the Windows host-crash-containment protocol version. An older daemon may still support ordinary attach, but it must reject a new supervised spawn that requires this guarantee before any process action. macOS, Linux, SSH, and paired or federated runtimes do not gain an equivalent guarantee from this Windows capability; their execution host must provide its own negotiated exact evidence or recovery fails closed.

## Canonical lifecycle

`worker_execution_resources.lifecycle_state` is the only lifecycle authority. Adapter-specific identity and receipts cannot introduce another lifecycle state machine.

| State               | Meaning                                                                  | Resource actionable       | Capacity available |
| ------------------- | ------------------------------------------------------------------------ | ------------------------- | ------------------ |
| `owned`             | The active Dispatch owns exact execution-resource custody.               | Only to that Dispatch     | No                 |
| `retained`          | Release is intentionally deferred.                                       | No                        | No                 |
| `release_requested` | Post-completion release was accepted.                                    | Exact release path only   | No                 |
| `release_closing`   | Exact terminal teardown is in progress.                                  | Exact release path only   | No                 |
| `release_unknown`   | Teardown outcome or custody is unverifiable.                             | No                        | No                 |
| `contained`         | An operator authorized recovery without claiming the old process exited. | No                        | No                 |
| `released`          | Exact host evidence proves the owned execution ended.                    | No                        | Yes                |
| `transferred`       | Custody moved to another Dispatch.                                       | Only to the current owner | No                 |
| `user_owned`        | A user took ownership outside orchestration.                             | Not by orchestration      | No                 |
| `external`          | Orca never owned the execution resource.                                 | Not by orchestration      | No                 |

Liveness is observed separately and never encoded by changing lifecycle vocabulary.

## Exact release

Every adapter follows the same release transition:

```text
owned -> release_requested -> release_closing -> released
                                      |
                                      +-> release_unknown
```

From `release_unknown`, exact `exited` evidence permits transactional settlement with no new execution action. Exact `live` evidence plus unchanged Dispatch, adapter identity, owner generation, host scope, and custody permits one exact adapter stop. `live` with an identity or authority conflict, and every `unverifiable` result, stays `release_unknown` with no execution action.

The archived worker output survives every release and reconciliation transition. Retrying or concurrently reconciling the same resource must not duplicate process action or capacity return.

### Receipt and archive boundaries

An adapter receipt is an execution-host assertion bound to the exact resource identity, owner generation, stable operation, and host scope. Worker v32 may retain its reference and settlement projection, but it must not copy the adapter's internal lifecycle into a second ledger. Replay reads the same receipt; it never synthesizes a replacement identity or repeats an ambiguous action.

The Worker archive is a business-result projection. It is not provider history, a continuation snapshot, or proof that execution exited. A future Agent Session adapter may reference provider-owned history or a handoff snapshot, but those remain distinct artifacts with distinct owners. Only the canonical resource lifecycle can return capacity or finalize custody.

Unexpected-exit handling freezes archive input before clearing volatile provider status or Terminal tail state. Provider-owned transcript evidence has priority; when it is unavailable, the same execution host supplies the retained Terminal history for the exact incarnation. Only a proven empty source may settle as `empty`. Release consumes this frozen input idempotently and does not create a second archive owner.

### Terminal receipt meaning for uncertain close outcomes

`processAction` records a proven process action, not merely an attempted API call. If the terminal close path returns `ptyKilled=false`, or reports an `unverifiable` stop outcome, the system must keep the resource in `release_unknown` and return `processAction=none`. It must not describe the result as `closed_agent_terminal` unless the contract is explicitly changed to distinguish an attempted close from a proven process action. This distinction prevents a coordinator or retry from treating uncertain custody as settled.

## Authorized containment

Containment is an explicit recovery decision for `release_unknown`; it is not evidence of exit, does not imply retry, and never performs a process action. One atomic transaction must:

1. verify the current coordinator, Run, Task, source Dispatch, resource, Delivery, and explicit authorization;
2. record a durable mutation identity and recovery receipt;
3. move the resource to `contained` while preserving process identity, host evidence, release error, and archive;
4. fence the source physical workspace generation;
5. resolve the current Delivery as containment rather than ordinary ACK;
6. retain a capacity debt for the contained resource; and
7. persist one immutable recovery disposition.

The disposition is one of:

- `accept_archived_result`: the durable archive is authoritative, so containment finalizes that business result without creating a successor; or
- `retry_with_successor`: the result is incomplete or untrusted, so the transaction accepts exactly one successor Dispatch in a fresh trusted generation.

Successor revision, placement, name, and agent are valid only for `retry_with_successor`. They are forbidden for `accept_archived_result`. The authorization and mutation identity are bound to the disposition, so replay cannot switch modes. A recovery record that already accepted a successor remains `retry_with_successor`; it is never reclassified as archive acceptance by inference.

Both dispositions acknowledge that the unverifiable old worker may still produce external effects. Archive acceptance additionally asserts that the preserved business result is authoritative. Retry additionally acknowledges the risk that the old execution may have performed effects not reflected in its archive. Containment never targets visible processes. A late exact `exited` verdict may move `contained` to `released` and return capacity exactly once; `live`, `unverifiable`, or conflicting identity leaves it contained with no process action.

`release_unknown` is the only containment admission state. A worker outcome such as `stopped` or `abandoned`, a missing terminal, or an unverifiable probe cannot bypass the canonical release transition. If a failed generation loses its terminal, the lifecycle owner must preserve its identity and archive while moving the exact resource through the same release decision before containment is considered.

Late settlement is resource-state driven, not worker-outcome driven. A contained resource may reach `released` from its own exact late `exited` evidence even when its Dispatch is failed or abandoned. That transition never changes a containment-resolved Delivery into an ordinary acknowledgement.

## Successor execution generation

A Run and Task are logical identities. A worktree, terminal, process tree, and Dispatch attempt belong to one physical execution generation. This section applies only to `retry_with_successor`. Archive acceptance creates no worktree, terminal, process, prompt, or successor effect. Retry preserves the Run and Task but starts the single preaccepted successor in a distinct isolated Git worktree at the authorized immutable revision.

Ordinary retry of a failed latest Dispatch does not require changing a logically runnable Task from `ready` to `failed`. `retryOf` admission verifies the exact latest Dispatch outcome, its settled execution resource, and the unchanged workspace/generation fences. An owned, retained, release-in-progress, contained, or unverifiable prior resource blocks retry; an exact release, or an explicitly admitted user-owned transfer, permits it. Task status alone never overrides those facts.

Orca must not read, clean, reset, copy, or reuse the old physical workspace after custody is lost. The normal worker-start owner creates the successor workspace and performs one atomic execution start. Recovery does not create a second worker-start route.

Accepting one successor Dispatch does not by itself make its external effects unique. Before execution start, the Worker owner durably claims the successor generation and persists one stable operation identity plus payload fingerprint. A concurrent caller that does not hold the claim reads the same operation without performing an effect. Process-local promise or TTL deduplication may supplement this rule, but cannot replace it.

Every half-complete stage must be restart-resumable. Worktree creation remains its own durable effect because it may complete before setup. Agent process creation and first-turn submission are one `execution_start` effect. Before spawn, Worker reserves the deterministic execution identity, WriteFence, provisional Dispatch capability, complete prompt, and payload fingerprint. The capability is unusable until the execution receipt is accepted. After a restart, exact readback identifies the same worktree generation and execution-start operation; the executor must not repeat an effect, search by name, path, terminal, PID, or command line, create another successor, or replace an unverifiable operation.

The Agent Session execution owner receives the stable operation identity, workspace, provider, launch preferences, deterministic placement, complete prompt, payload fingerprint, and WriteFence in one create request. Worker does not receive, construct, or choose a shell command. The execution owner resolves the provider on the execution host and must produce one structured agent-process target containing the executable, argument vector, environment patch, and expected process identity. A launch plan that returns a shell command, follow-up input, or any post-start PTY input is unsupported for supervised Worker start and fails before spawn.

PTY creation has two explicit and mutually exclusive meanings. An ordinary interactive Terminal or setup surface may create a shell and optionally run a shell command. A supervised Agent Session creates the resolved agent process directly inside the PTY. The shell-command form is not a compatibility route or fallback for the agent-process form, and Worker has no branch that can select it. Both forms may reuse the same PTY registration, presentation, history, containment, stop, release, and archive machinery because those are custody responsibilities rather than command-submission semantics.

For native Windows Codex, the structured target resolves to an admitted native executable or an explicit non-interactive PowerShell `-File` invocation of the known Codex launcher. It does not create an interactive PowerShell, use `-NoExit`, or ask a shell parser to interpret the prompt. Arbitrary command overrides are not supervised launch evidence. The execution owner must validate the fully rendered process argument budget before mutation; an oversized or unresolvable launch fails closed instead of switching to shell input, stdin, a prompt file, or another adapter.

The execution-start receipt binds the exact Session and process incarnation, host scope, operation identity, WriteFence, and genuine provider turn-start evidence. Within Agent Session execution-start identity, WriteFence is the single writer-generation field; the Worker execution-resource owner generation remains a separate custody fact. Provider acceptance carries one provider-observed acceptance time bound to the launch token and operation; a time window is not identity. An observation timeout belongs to the caller's wait policy and is not part of the durable operation identity. Only the exact receipt activates the provisional Dispatch capability and permits the Dispatch to reach `ready/input_accepted`. Process spawn, argument delivery, terminal output, a visible composer, or a transport receipt alone never proves acceptance.

The supervised Worker path has no post-start prompt paste, carriage return, submit retry, rescue input, or general Terminal-write fallback. Those mechanisms remain ordinary interactive UI behavior and cannot participate in Worker execution authority.

Provider support is evidence-based. A generic launch configuration such as positional prompt input does not establish supervised support. Each admitted provider must prove the complete real prompt, exactly-once create and first-turn behavior, restart inspection, exact turn-start receipt, writer fencing, and release path on the execution host. The initial production slice admits only local Codex after that proof. External terminals, command overrides, other agents, SSH, paired, and federated execution fail at Worker admission before accepting a Dispatch, claiming an operation, creating a worktree, or spawning a process until they independently satisfy the same contract.

This slice does not introduce a generic AgentTurn ledger, provider adapter factory, or capability registry. If native Codex Session creation cannot satisfy the proof, implementation stops for a separate execution-adapter decision; it does not add an app-server or PTY fallback inside the same runtime path.

Exact execution-start inspection exposes only `not_started`, `started`, `accepted`, `conflict`, or `unverifiable`. `not_started` permits the current claimant to perform the one create operation. `started` resumes observation of the same operation without submitting input. `accepted` replays the same receipt. `conflict` and `unverifiable` fail closed without clearing the operation or creating another Session.

An identity mismatch, lost transport without execution-host readback, unsupported provider, partial create, or ambiguous turn remains `unverifiable`. It is never expired, superseded, converted to acceptance, or replayed through Terminal input. An Orca-created execution resource proceeds through the canonical stop/release owner; no other path may release its capacity.

Exact daemon death follows the execution-resource lifecycle rather than proving execution-start acceptance. Windows host-Job containment may prove the Terminal generation exited after daemon death, but it does not create an execution receipt or authorize non-Windows inference.

The operation records are a narrow worker-generation contract, not a generic AgentTurn ledger, saga, or second worker-start route. Schema v30 establishes nested worker depth, v31 installs the canonical execution-resource lifecycle and containment tables, and v32 adds dispositions and exact generation operations. Production uses one canonical operation model rather than parallel old and new execution paths.

### Target implementation plan

1. Freeze and consume the provider-neutral Session reference, Writer owner, and WriteFence contracts without copying Worker state into the Cross-Agent model. Merge any duplicate Agent Session writer-generation field into WriteFence without changing the Worker execution-resource custody generation.
2. Replace the string-only PTY launch contract with one discriminated spawn target: `shell-command` for ordinary interactive/setup surfaces and `agent-process` for supervised Agent Sessions. The variants are mutually exclusive and have no fallback edge.
3. Make the Agent Session execution owner resolve local Codex into an execution-host-owned executable, argument vector, environment patch, and expected process identity. Worker supplies only the logical execution intent, complete preamble, launch preferences, deterministic placement, operation identity, payload fingerprint, and WriteFence.
4. Move unsupported-provider and unsupported-host admission before every Dispatch, operation, worktree, and process mutation. The production slice rejects external-terminal reuse, arbitrary command overrides, every non-Codex agent, SSH, paired, and federated execution.
5. Preallocate the execution identity and provisional Dispatch capability, activate authority only from an exact provider turn-start receipt, and persist durable execution-host inspection for the same create operation across runtime restart. Bind acceptance to the operation and launch token; keep caller timeout outside durable identity and do not add a provider turn ledger to Worker persistence.
6. Delete the Worker-specific prompt transport, inspection, CR pacing, semantic recovery, and fallback branches in the same production slice. Validation exercises only the final agent-process path; the ordinary shell-command variant remains a separate Terminal/setup capability and cannot satisfy Worker authority.
7. Validate the real Windows Codex candidate with a complete Task-sized prompt, special quoting/newline/CJK payloads, one process spawn, one provider first turn, a restart between process spawn and create reply, the same operation receipt, exact release, archive preservation, and one capacity return. Keep every unproved provider and remote host fail closed.

The source `worker_done`, archive, containment resolution, and Delivery remain audit history. A coordinator restart or rebind may receive the successor's `worker_done`; it must not replay the source completion as new work.

Terminal list/show projections keep connectivity separate from custody: a connected `release_unknown` or `contained` terminal reports `writable=false` and its `custodyState`. Worker list/show links the source Delivery, recovery disposition, optional successor Dispatch/worktree, and withheld or released capacity debt.

## Delivery, Task, and Gate progression

A containment-resolved source Delivery remains a distinct audit outcome permanently. It is never converted to ordinary `acknowledged`, including after the contained resource later reaches `released`. Archive acceptance has no successor Delivery. In retry mode, only the final successor's actionable completion Delivery follows the normal acknowledgement path.

Worker output is not the logical completion boundary by itself. A successful report first preserves the result and archive as pending finalization. For `accept_archived_result`, the same atomic transaction that validates the authoritative archive, contains the resource, and resolves its Delivery finalizes the logical Task. For `retry_with_successor`, the successor must complete its business work, preserve its archive, release its exact execution resource, and have its actionable Delivery processed before the logical Task becomes terminal. Dependent Tasks and a Producer Gate advance only from this disposition-aware finalization owner.

Containment does not return the old capacity in either mode. Advancing a Task after accepted archive containment means the ownership risk is explicitly fenced and accounted as capacity debt, not hidden by ACK. This ordering must be enforced at one completion owner. Do not promote dependents early and add a later compensating demotion path.

## Validation profiles and production recovery

An Orca Dev profile is a separate lifecycle authority from the installed Orca profile. Its database, runtime identity, daemon custody, terminal inventory, Delivery ledger, and capacity accounting are independent. A successful development-profile rehearsal proves that the compiled components are wired together; it does not settle or authorize a resource recorded by another profile.

The default development profile is shared by development worktrees and is not disposable. A recovery rehearsal must select a unique `ORCA_DEV_USER_DATA_PATH`, keep its runtime and temporary state outside the source worktree, and use the matching Orca Dev CLI for every operation. The operator must verify that the selected path is different from both the installed profile and the default development profile. Cleanup may address only processes and paths whose ownership by that rehearsal is exact.

A dedicated development rehearsal may coexist with the installed Orca when its profile, runtime, socket, daemon, temporary roots, and generated outputs are separate. Before launch, resolve the development scripts' output paths and stop if any step would overwrite an executable or package tree used by the installed application.

Validation has three evidence layers:

1. deterministic fixtures inject close uncertainty and prove lifecycle, Delivery, retry, and capacity transitions;
2. a dedicated development profile proves the compiled CLI, runtime, daemon, schema, capability, and benign supervised-worker lifecycle; and
3. an explicitly authorized production-profile operation proves recovery of a real incident.

Do not add a development-only RPC or execution route to collapse these layers into one test. A copied database also does not transfer PTY/Job custody or execution-host authority.

A package build that writes an output tree used by a running application waits for the operator to close that application. The validator announces the boundary and remains idle for the operator's explicit confirmation; it does not poll destructively, keep a build command active, or terminate the application. After confirmation it observes exact process exit, performs a fresh writer/build admission, and only then starts the build. If the close also removes the daemon or validation terminal, validation stops and resumes manually after relaunch; lost transport is not evidence that a build completed. After the build and package probes pass, restarting the application verifies runtime and profile identity continuity. It does not authorize production recovery or profile mutation.

Validation and implementation converge on the target architecture directly. There is no backward-compatible recovery route, transitional adapter, shadow state, or patch-on-patch fallback for a missing runtime receipt. If an existing validation seam cannot launch the admitted executable with the required isolated profile, the correct outcome is an explicit evidence gap and a STOP. A minimal change is acceptable only inside that existing seam and only when it selects the target executable/profile directly. Mixed-version capability admission remains a fail-closed contract; it is not an alternate execution path.

Before a production recovery, stop competing profile writers, bind the candidate to an exact source manifest, create and restore-test a complete profile backup, and verify the current Run, coordinator generation, Dispatch, Delivery, execution resource, adapter authority, capability, trusted revision, and workspace provider. A one-way schema migration makes a partial binary rollback unsafe; rollback requires restoring the complete pre-migration profile.

The runtime performing production recovery must preserve the installed application's profile and credential identity. Merely pointing an Orca Dev process at production data does not satisfy that requirement and is no longer an isolated operation. The recovery request still performs no action on the old process, uses one durable mutation identity, and keeps capacity withheld. Archive acceptance creates no successor. Retry starts one successor in a fresh trusted generation through the durable operation contract. Git delivery is independent and may follow only after the operator accepts the recovery evidence.

### Current delivery-readiness checkpoint

The lifecycle contract is not considered runtime-proven until the compiled validation path demonstrates the same exact Worker resource, Terminal adapter, Job/Session authority, archive, and release owners described here. A deterministic seam pass is useful evidence, but it does not replace that runtime receipt. If a harness launches a different executable or profile than the admitted candidate, classify the result as a validation-entry mismatch and stop; do not infer a lifecycle failure or repair it with a new execution route.

The execution-start proof uses a complete Task-sized Codex prompt on the real Windows candidate. It must show one Session and one first turn, exact acceptance after a runtime restart between process spawn and create reply, archive preservation, exact release, and one capacity return. Failure to carry the prompt or recover the same operation is a design falsifier and a STOP, not permission to restore Terminal prompt delivery.

The first packaged proof falsified the string launch shape rather than the lifecycle contract. A roughly 12.8K complete Worker prompt reached an interactive PowerShell as command text, left the shell at its continuation prompt, and never started Codex. The operation correctly settled as an unknown execution start without claiming input acceptance. The only admitted next proof replaces that shell parse with the final structured agent-process target; increasing shell limits, changing quoting, using a wrapper that still evaluates command text, or restoring post-start input is not an implementation option.

An uncertain terminal close has the same fail-closed meaning at every projection: `release_unknown`, `processAction=none`, no actionable custody, and no capacity return. The field must never claim `closed_agent_terminal` solely because a close API was invoked. Before a package or production gate is sealed, reconcile the candidate executable, profile identity, process ownership, manifest, and receipt from one fresh admission. Conflicting historical snapshots are **Needs verification**, not a delivery approval.

When a packaged validation process fails before lifecycle code runs, diagnosis and repair use one bounded decision. First gather read-only evidence from the exact candidate and isolated profile. Only an existing E2E or packaging owner may then receive one direct target-architecture fix, and only when it needs no new dependency, native patch, runner, GPU workaround, compatibility route, or temporary fallback. Otherwise the result is an explicit runtime-evidence gap and a STOP; no lifecycle state may be upgraded from an unexecuted process.

### Validation admission and external package drift

Validation is valid only for the exact source and package inputs that were admitted. If the package manifest or lockfile changes unexpectedly after admission—especially if scripts or development dependencies disappear—the worktree enters a safety stop. Do not restore, reset, stash, normalize, or overwrite the drift by assumption. First identify the writer and classify whether the change is owned by the current operation; preserve all unclassified bytes.

After an explicitly attributable restoration, perform a fresh admission, format only the final explicit paths, recalculate the candidate manifest, and rerun the complete applicable validation gates. Earlier test counts, build receipts, and aggregate hashes are historical until they are reproduced from the latest admitted bytes. This gate protects evidence integrity; it does not change custody semantics or authorize production recovery.

## Provider boundaries

- Local Git retry requires an existing provider that can create an isolated worktree from the exact trusted revision. Archive acceptance does not invoke a workspace provider.
- Folder workspaces without an isolation provider fail closed.
- SSH transport loss is `unverifiable`. Recovery requires execution-host authority and an advertised isolated-generation capability.
- Paired and federated workers fail closed unless the home and execution host negotiate the full containment-recovery capability. The home side never adopts a remote PID.
- Resources without durable exact custody remain fail closed. They require an explicitly authorized containment decision and disposition; they are never auto-released or auto-replayed.

Mixed-version admission must reject unsupported recovery before any durable or external effect. There is no compatibility execution route.
