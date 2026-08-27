# Worker terminal lifecycle

Orca must account for every supervised worker terminal without guessing whether its process tree is gone. This contract separates process evidence, terminal custody, Delivery progress, physical workspace generations, and capacity accounting.

## Authority and evidence

The execution host owns process evidence and process actions. A terminal handle, inventory entry, connection, writable transport, PID, ancestry, command line, or stale runtime identity is not custody. Exact custody comes from the execution host's current PTY/Job owner and recorded process incarnation.

Process liveness has exactly three verdicts: `live`, `unverifiable`, and `exited`. Only positive evidence from the execution host establishes `exited`. Missing inventory, lost transport, permission failure, daemon restart, and identity ambiguity are `unverifiable`.

An empty process list is not positive exit evidence for SSH or a paired runtime. The execution host must return an identity-bearing verdict for the recorded process incarnation under a negotiated capability. A client-side classifier may confirm `live` from an exact match, but it must not convert remote absence into `exited`. For a local supervised worker, an exact probe proving that the recorded old daemon process incarnation is gone can establish `exited`; access denial, transport loss, or ambiguous identity cannot.

Never reconstruct custody from PID, ancestry, command line, terminal ID, or proximity. Never use broad termination to reconcile a worker resource.

### Windows containment capability

The lifecycle and fail-closed evidence rules are cross-platform. Native Windows adds two Job Object guarantees for supervised workers:

1. the per-PTY Job owns explicit teardown of one terminal process tree; and
2. the daemon host Job contains all supervised PTYs if that daemon process exits unexpectedly.

These owners are complementary. Terminating a per-PTY Job can prove that one owned tree ended even when ConPTY never publishes its JavaScript exit callback. The daemon host Job prevents future supervised workers from surviving the loss of their custody owner. Neither Job authorizes a restarted daemon to adopt a legacy PID or terminal.

The exact daemon-crash guarantee is available only for native Windows supervised workers created by a daemon at or above the Windows host-crash-containment protocol version. An older daemon may still support ordinary attach, but it must reject a new supervised spawn that requires this guarantee before any process action. macOS, Linux, SSH, and paired or federated runtimes do not gain an equivalent guarantee from this Windows capability; their execution host must provide its own negotiated exact evidence or recovery fails closed.

## Canonical lifecycle

`worker_terminal_resources.lifecycle_state` is the only lifecycle authority.

| State               | Meaning                                                                  | Terminal actionable       | Capacity available |
| ------------------- | ------------------------------------------------------------------------ | ------------------------- | ------------------ |
| `owned`             | The active Dispatch owns exact terminal custody.                         | Only to that Dispatch     | No                 |
| `retained`          | Release is intentionally deferred.                                       | No                        | No                 |
| `release_requested` | Post-completion release was accepted.                                    | Exact release path only   | No                 |
| `release_closing`   | Exact terminal teardown is in progress.                                  | Exact release path only   | No                 |
| `release_unknown`   | Teardown outcome or custody is unverifiable.                             | No                        | No                 |
| `contained`         | An operator authorized recovery without claiming the old process exited. | No                        | No                 |
| `released`          | Exact host evidence proves the owned execution ended.                    | No                        | Yes                |
| `transferred`       | Custody moved to another Dispatch.                                       | Only to the current owner | No                 |
| `user_owned`        | A user took ownership outside orchestration.                             | Not by orchestration      | No                 |
| `external`          | Orca never owned the terminal resource.                                  | Not by orchestration      | No                 |

Liveness is observed separately and never encoded by changing lifecycle vocabulary.

## Exact release

Normal release follows:

```text
owned -> release_requested -> release_closing -> released
                                      |
                                      +-> release_unknown
```

From `release_unknown`, exact `exited` evidence permits transactional settlement with `processAction=none`. Exact `live` evidence plus unchanged Dispatch, terminal, process incarnation, host scope, and custody permits one exact close. `live` with an identity or authority conflict, and every `unverifiable` result, stays `release_unknown` with `processAction=none`.

The archived worker output survives every release and reconciliation transition. Retrying or concurrently reconciling the same resource must not duplicate process action or capacity return.

### Receipt meaning for uncertain close outcomes

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

Orca must not read, clean, reset, copy, or reuse the old physical workspace after custody is lost. The normal worker-start effect owner creates the successor workspace, terminal custody, readiness, authority attachment, and prompt delivery through its existing durable stages. Recovery does not create a second worker-start route.

Accepting one successor Dispatch does not by itself make its external effects unique. Before each worker-start effect, the existing effect owner must durably claim the successor generation and persist a stable operation identity plus payload fingerprint. A concurrent caller that does not hold the claim returns the same receipt without performing an effect. Exact readback exposes only `not_started`, `completed`, `conflict`, or `unverifiable`. Process-local promise or TTL deduplication may supplement this rule, but cannot replace it.

Every half-complete stage must be restart-resumable. After a restart, the existing managed-worktree, terminal/session, and prompt owners reconcile the exact stable operation identity, then the shared worker-start executor continues the same successor generation. Worktree readback identifies the exact created generation. Terminal readback includes handle, pane, process incarnation, host scope, and restart custody. Prompt readback proves that one payload was accepted once by that terminal incarnation. The executor must not repeat an effect, search by name, path, terminal, PID, or command line, create another successor, or freeze an otherwise provable effect as permanently unknown.

The runtime remains the semantic owner of worker prompt delivery: it checks generation, authority, and permission before writes, then frames paste chunks, paces rendering, and submits. The daemon Session is the sole durable completion authority for a supervised-worker prompt operation. A protocol-gated operation binds the stable operation ID and payload fingerprint to the exact Session incarnation and terminal identity, reports lower write rejection instead of swallowing it, and records completion after the submit write succeeds but before replying. Agent-activity observation may remain advisory or validate an ordinary interactive prompt, but it must not override an exact Session completion receipt, fail the Dispatch, or revoke its capability.

If the runtime loses or cannot classify the submit reply, it immediately inspects the same exact Session operation. `completed` persists the database receipt and permits the Dispatch to reach `ready/input_accepted`; `not_started` cannot be recorded as completed; `conflict` or `unverifiable` fails closed without resending. This reconciliation stays inside the existing prompt effect owner and does not add another worker-start route, prompt state, protocol version, or recovery service.

Prompt inspection exposes only `not_started`, `completed`, `conflict`, or `unverifiable`. A partial payload, queued shell-ready write, identity mismatch, lost transport without owner readback, or unsupported execution provider is `unverifiable`; it is never resumed by offset, converted to completion, or replayed through general terminal input. Exact daemon death follows the terminal custody lifecycle rather than proving prompt completion. This is a cross-platform daemon protocol contract. Windows host-Job containment may prove the terminal generation exited after daemon death, but it does not change the prompt vocabulary or authorize non-Windows inference.

The operation records are a narrow worker-generation contract, not a generic saga or second worker-start route. Schema v30 establishes nested worker depth, v31 installs the canonical terminal lifecycle and containment tables, and v32 adds dispositions and exact generation operations. After migration, production uses one canonical operation model rather than parallel old and new execution paths.

The source `worker_done`, archive, containment resolution, and Delivery remain audit history. A coordinator restart or rebind may receive the successor's `worker_done`; it must not replay the source completion as new work.

Terminal list/show projections keep connectivity separate from custody: a connected `release_unknown` or `contained` terminal reports `writable=false` and its `custodyState`. Worker list/show links the source Delivery, recovery disposition, optional successor Dispatch/worktree, and withheld or released capacity debt.

## Delivery, Task, and Gate progression

A containment-resolved source Delivery remains a distinct audit outcome permanently. It is never converted to ordinary `acknowledged`, including after the contained resource later reaches `released`. Archive acceptance has no successor Delivery. In retry mode, only the final successor's actionable completion Delivery follows the normal acknowledgement path.

Worker output is not the logical completion boundary by itself. A successful report first preserves the result and archive as pending finalization. For `accept_archived_result`, the same atomic transaction that validates the authoritative archive, contains the resource, and resolves its Delivery finalizes the logical Task. For `retry_with_successor`, the successor must complete its business work, preserve its archive, release its exact terminal, and have its actionable Delivery processed before the logical Task becomes terminal. Dependent Tasks and a Producer Gate advance only from this disposition-aware finalization owner.

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

Before a production recovery, stop competing profile writers, bind the candidate to an exact source manifest, create and restore-test a complete profile backup, and verify the current Run, coordinator generation, Dispatch, Delivery, terminal resource, capability, trusted revision, and workspace provider. A one-way schema migration makes a partial binary rollback unsafe; rollback requires restoring the complete pre-migration profile.

The runtime performing production recovery must preserve the installed application's profile and credential identity. Merely pointing an Orca Dev process at production data does not satisfy that requirement and is no longer an isolated operation. The recovery request still performs no action on the old process, uses one durable mutation identity, and keeps capacity withheld. Archive acceptance creates no successor. Retry starts one successor in a fresh trusted generation through the durable operation contract. Git delivery is independent and may follow only after the operator accepts the recovery evidence.

### Current delivery-readiness checkpoint

The lifecycle contract is not considered runtime-proven until the compiled validation path demonstrates the same exact Job, Session, terminal, archive, and release owners described here. A deterministic seam pass is useful evidence, but it does not replace that runtime receipt. If a harness launches a different executable or profile than the admitted candidate, classify the result as a validation-entry mismatch and stop; do not infer a lifecycle failure or repair it with a new execution route.

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
- Legacy resources without durable exact custody remain fail closed. They require an explicitly authorized containment decision and disposition; they are never auto-released or auto-replayed.

Mixed-version admission must reject unsupported recovery before any durable or external effect. There is no compatibility execution route.
