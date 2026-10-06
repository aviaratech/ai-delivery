# ai-delivery

Generic GitHub issue and pull request delivery with Git/GitHub discovery and a source-controlled `RepositoryDeliveryPolicy@1` module. Routing overrides are optional. The package provides one `ai-delivery` CLI, one stdio MCP server, and thin plugin assets in `plugins/ai-delivery`.

The package contains no repository-specific policy, credential, model, or deployment configuration. A consuming repository owns its issue taxonomy, author and reviewer credentials, native Project fields, delivery stages, and phase constraints. The runtime refuses an untracked override file or a missing or untracked policy module. Credentials and delivery policy remain explicit.

## Availability and installation

Install the versioned package from npm or a reviewed package archive. The
consuming repository must run its own configuration and runtime-admission
procedure before any lifecycle write.

The selected CLI, MCP server and verification controller use Node 24.21.0 and
npm 11.19.0. The public library exports also support Node 26.2.0 consumers.
Package checks run the Node 24 controller against actual npm-packed Node 26
consumers, including filesystem fixture contention, reader and link rejection,
success/failure teardown, cancellation, leaked fixtures and positive byte limits.
For package development, set `AI_DELIVERY_NODE26_EXECUTABLE` to the absolute
Node 26.2.0 executable before `npm run checks`; CI retains that executable while
selecting Node 24 for the canonical commands.

```sh
node --version # 24.21.0
npm --version  # 11.19.0
npm install --save-dev @aviaratech/ai-delivery@0.3.4
npx ai-delivery --help
npx ai-delivery --repo-root /absolute/path/to/consumer --identity configured-author info --issue 17
npx ai-delivery --repo-root /absolute/path/to/consumer --identity configured-author mcp:serve
```

`info` is a read. `verify`, PR publication, formal review submission and finish
are lifecycle writes. The CLI and MCP server enforce the same admission and
identity rules. The [plugin guide](plugins/ai-delivery/README.md) covers host
installation.

## Configure a consuming repository

Keep the repository's delivery policy in `ai-delivery.policy.mjs` at its Git
root. Its default export remains `RepositoryDeliveryPolicy@1`, implementing
`classifyExactRange` and `validateBoundary` with the repository's actual required
checks, stages, risk and publication/merge constraints. There is no permissive
default policy. Add a named `deliverySettings` export for explicit authentication
roles and command settings:

```js
export const deliverySettings = {
  roles: {
    author: {
      identity: 'delivery-author',
      credentialEnv: {
        appId: 'DELIVERY_AUTHOR_APP_ID',
        installationId: 'DELIVERY_AUTHOR_INSTALLATION_ID',
        privateKeyPath: 'DELIVERY_AUTHOR_KEY_PATH',
      },
    },
    reviewer: {
      identity: 'delivery-reviewer',
      credentialEnv: {
        appId: 'DELIVERY_REVIEWER_APP_ID',
        installationId: 'DELIVERY_REVIEWER_INSTALLATION_ID',
        privateKeyPath: 'DELIVERY_REVIEWER_KEY_PATH',
      },
    },
  },
  commandPolicy: {
    checks: { format: 'REQUIRED', gitClean: 'REQUIRED', lint: 'REQUIRED', test: 'REQUIRED', typecheck: 'REQUIRED' },
    timeoutsMs: { lint: 60000, test: 60000, typecheck: 60000 },
  },
};
// Retain the default RepositoryDeliveryPolicy@1 export with real stage commands.
```

No JSON file is needed when discovery is unambiguous. The resolver reads the
checkout's single GitHub remote, verifies its repository identity with GitHub,
and discovers repository issue types and inherited organization issue fields.
The standard field names are `Points`, `Priority` and `Status`, with workflow
options `Todo`, `In Progress`, `Blocked` and `Done`. Points and Priority must be
native organization single-select issue fields bound into the Project; unrelated
Project-owned fields are rejected. This release supports github.com organization
repositories, matching the existing native metadata contract.

The default Project is the one compatible open Project linked to that repository
and visible to the configured discovery identity. All pages are read before
selection. Zero or multiple compatible Projects require an explicit choice.
API failures, null/partial results, and an unwritable compatible Project fail
without falling back to another destination. No Project is inferred from issue
history, its name, or organization-wide availability. GitHub's Project-to-default-
repository setting does not define a repository's default Project. Linked
Projects must belong to the repository organization.

For exceptions, commit a small `ai-delivery.config.json`, for example:

```json
{
  "schemaVersion": "ai-delivery.config@2",
  "remote": "upstream",
  "project": 7,
  "policy": { "module": "./scripts/delivery-policy.mjs" }
}
```

Every field is optional. Multiple remotes require `remote`; a GitHub fork also
requires an explicit remote choice. `repository`, when present, is an assertion
against that remote. `project` explicitly selects an organization Project number
and takes precedence over linked-project discovery. `pointsField`,
`priorityField`, `statusField`, and `statuses` (all four `todo`, `inProgress`,
`blocked`, `done` names) express custom meanings without copying GitHub IDs or
option catalogs. Optional `issueTypes` restricts the discovered enabled types;
unavailable types are refused. IDs, titles and available choices remain GitHub
facts. Unknown keys and legacy full-config files are refused.

Worktree bases, verification, PR fetches and cleanup all use the selected remote's
tracking refs. Fetch that remote and set its remote HEAD before delivery when its
default branch is not `main`; delivery never falls back to another remote or a
local branch to establish its base.

For App roles, set environment variables for the App ID, installation ID and absolute
private-key path. Secret values and keys stay outside Git. The author App needs
Contents, Issues, organization Projects and Pull requests write permissions plus
read access to repository issue types and fields. Discovery uses that author
identity; review operations still use the distinct reviewer App (Contents read
and Pull requests write suffice to submit a review). For that App's approval to
satisfy a required-review rule, configure Contents write as well. Contents write
also grants the App real code-write capability; grant it only when that review
route is intended. Accept the App's new permissions on its installation and
obtain fresh installation credentials before relying on the changed grant.
Existing App author configurations remain valid.

To use the host user's GitHub identity for publication, replace only the author
role in `deliverySettings`:

```js
author: {
  identity: 'host-author',
  authSource: 'personal',
  credentialEnv: { token: 'DELIVERY_AUTHOR_TOKEN' },
},
```

Set `DELIVERY_AUTHOR_TOKEN` outside source control to a token for the intended
user. The runtime reads only that named variable for this route, uses the same
token for Git HTTP push and GitHub API calls, and verifies the user login. It
does not use an ambient `gh` session or another environment token. The legacy
`--identity personal --personal-auth` override remains explicit for development
and `config:resolve`; configure the personal author role above for complete PR
delivery with matching review artifacts and policy evidence.

| Route | Package behavior | Native required approval |
| --- | --- | --- |
| Configured personal author + reviewer App | One App submits the exact-head independent review. | With Contents write accepted on the App installation, confirm that GitHub counts it; an eligible independent human may still need to approve if another rule blocks it. |
| Author App + reviewer App | Existing separate App roles keep their credential and review bindings. | With Contents write accepted on the reviewer App installation, confirm that GitHub counts its approval. |
| Author App + eligible human reviewer | A valid GitHub route for a repository that requires human approval; the current package still needs its configured reviewer App for the formal artifact receipt. | The human reviews and approves in GitHub. |

GitHub requires qualifying approvals under [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) and [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets). Pull requests write permits submitting a review; it does not grant repository write access for a required approval. When a required-approval rule is visible and the reviewer App's effective Contents grant is read-only, `pr:create --dry-run` reports `approvalEligibility: insufficient-permission` before publication. Unknown grants or rules remain `unknown`. The post-review readback reports `submittedReviewAuthorCanPushToRepository` when GitHub exposes it for the exact submitted review. Neither an App's scopes nor a submitted `APPROVED` review proves that it counted. The live PR `reviewDecision` is the required-review readback; it does not attribute a counted approval to one actor. Recheck it on the current head before merge.

The local Git commit author is metadata. The selected author token authenticates
the push and PR creation; `issue_pr_info.authorLogin` confirms the actual PR
author. The independent artifact records its reviewer identity and effective
model, while the submitted review receipt records the GitHub actor. Keep these
identities separate when diagnosing a blocked PR.

Inspect the delivery access route before development and before issuing a new
runtime admission:

```sh
npx ai-delivery --repo-root /absolute/path/to/consumer --identity host-author config:resolve
# For the explicit development override under an App author policy:
npx ai-delivery --repo-root /absolute/path/to/consumer --identity personal --personal-auth config:resolve
```

This read returns `routing` (repository, Project/field/option identities and
selection source), `configDigest`, effective author and reviewer actors,
credential sources, reviewer repository read access, and available branch-rule
evidence. A partial or unknown rule view stays labeled unknown; it does not
require broader administrator access. Resolve a same-actor error, missing
configured credential or reviewer repository-access mismatch before development.
`develop`/`issue_develop`, starts that prepare worktrees, and
`worktree:create`/`issue_worktree_create` also run this existing access preflight
before preparing work. A new start with
`develop: true` checks it before creating the issue. Plain issue creation and
readiness checks retain their existing behavior. Access preflight does not issue
or refresh runtime admission, and does not prove that an approval will count.
The development override still checks the independent reviewer route; publication
requires the configured author credential.
Before publication, use `pr:create --issue 17 --dry-run` to inspect the current
route again. After `issue_pr_review`, inspect its
`reviewState` and `pr:checks`. If GitHub still reports `REVIEW_REQUIRED`, inspect
the active rule and obtain a qualifying independent approval; repeating the
same App review cannot resolve that state. CLI and MCP use the same asynchronous
`loadDeliveryConfig` resolver. `issue_create` and `issue_info` also expose the
resolved routing. An MCP server stays bound to its startup checkout; use separate
bindings or explicit CLI checkout selection for multiple repositories.

Public runtime setup has two explicit operations: `runtime:stage` and
`runtime:admit` (MCP: `runtime_stage` and `runtime_admit`; API:
`stageRuntime` and `admitRuntime` from `@aviaratech/ai-delivery/agent`). Both
require the clean primary consumer checkout, its expected Git HEAD, the actual
`loadDeliveryConfig` digest, an explicit configured author identity and separate
operation authority. The authenticated author and distinct reviewer App must
pass the existing repository-access preflight. Unknown rule visibility or
approval eligibility remains unknown; setup does not establish counted approval.

First read `config:resolve` with the configured author, then stage a reviewed
local archive using its independently accepted SHA-256 and package version:

```sh
ai-delivery --repo-root /absolute/consumer --identity configured-author config:resolve
ai-delivery --repo-root /absolute/consumer --identity configured-author runtime:stage \
  --authorize-stage --archive /absolute/reviewed-package.tgz \
  --archive-sha256 sha256:<reviewed-archive-digest> --package-version 0.3.5 \
  --source-commit <clean-primary-consumer-head> --config-digest sha256:<resolver-digest> \
  --runtime-directory /absolute/private-runtimes/ai-delivery-0.3.5
```

Stage captures and hashes the exact reviewed archive bytes, durably retains a
private copy in its owned directory, and gives that copy to npm. The snapshot
counts toward the stage output allowance and is revalidated on completion,
reuse and admission. Stage installs production dependencies with scripts, audit
and funding disabled.
It validates actual CLI, full distribution, package manifest, bundled MCP launcher
and plugin bytes and capability 2. Its private completion record binds these
bytes to the reviewed archive and primary controller; `sourceCommit` means the
consumer/controller HEAD, not the public package's release commit. Matching
completed stages are read back and reused without npm. Incomplete recovery uses
the existing durable verification writer and identity-checked command cleanup.
A live or stopped owner remains busy; ambiguous command ownership fails closed.
Failure or cancellation removes only owned incomplete output after confirmed
quiescence. Stage returns actual CLI/MCP launch descriptors and leaves host
references and current links for the consuming installer to manage.

Admission is the separate explicitly authorized final binding. Use the returned
stage ID and either explicit absence or the SHA-256 of the exact prior admission
file bytes:

```sh
ai-delivery --repo-root /absolute/consumer --identity configured-author runtime:admit \
  --authorize-admit --stage-id sha256:<returned-stage-id> --expected-absent \
  --source-commit <clean-primary-consumer-head> --config-digest sha256:<resolver-digest> \
  --runtime-directory /absolute/private-runtimes/ai-delivery-0.3.5
# For replacement, use --expected-prior sha256:<current-admission-byte-digest>
```

The operation rechecks archive, installed bytes, primary source, resolver routing
and configured actors before atomically publishing the existing private
`ai-delivery.runtime-admission@2` record at
`<git-common-dir>/ai-delivery/runtime-admission.json`, mode 0600. Precommit
failures preserve the prior record. A lost response or post-rename failure is
reconciled against exact desired bytes and confirmed file/directory durability.
A `commit-status-unknown` error identifies the admission and stage; retry the
same stage to reconcile. Conflicting third-party bytes are preserved. The
consuming installer's reviewed host activation and rollback determine when this
final write occurs.

The resolver's `configDigest` includes policy/settings source, validated
effective roles and checks, optional overrides and discovered routing;
**do not substitute a JSON-file hash**. Drift invalidates admission and
verification receipts. Ordinary lifecycle operations never refresh admission
implicitly, and candidate issue configuration is never activated by setup.

To migrate from 0.1: move `roles` and `commandPolicy` into the existing policy's
`deliverySettings` export; replace the old JSON with only necessary overrides
(or remove it when using the default policy filename); await `loadDeliveryConfig`
in installer integrations; review the resolved destination and reissue capability-2
admission using its digest. Do not upgrade old receipts into approvals. Existing
rows in `.issue-cli/worktrees.json` remain with their original runtime unless
they already have an exact `ai-delivery.worktree-owner@1` witness. Installing this
package never adopts or switches an active legacy writer.

Legacy worktree transitions are explicit and separate from installation. Use
`worktree:transition:inspect` (`issue_worktree_transition_inspect`) with the issue
and purpose `active-resume` or `merged-cleanup`. Inspection reads the canonical
row, clean source, native PR lineage, original evidence and writer inventory. It
returns an exact plan or specific closure gaps without writing ownership or
running the retained producer.

The supported operational closure family is the retained official public
`@aviaratech/ai-delivery@0.3.5` archive and installed bytes, its private
`ai-delivery.runtime-admission@2`, producer-bound `ai-delivery.run@3`, and
`ai-delivery.verification-writer@1` on supported POSIX hosts. Supply
`--retained-admission` and `--retained-archive`. Operative `issue-cli`
verification-stages v1/v2, unknown process ownership, external resource families
or incomplete inventory refuse apply. Historical producer identity may remain
`UNKNOWN`; its original schemas, bytes, failed diagnostics and accounting are
preserved without becoming current verification, review or retirement authority.

The configured authenticated personal operator must publish the returned whole
relinquishment body as a native comment on the terminal PR, or on the issue for
active resume. The distinct configured reviewer App must independently accept
the same complete plan and relinquishment comment ID through a native exact-body
acceptance comment. A caller-authored local receipt does not supply this
authority. Changed/deleted comments, wrong actors or subjects, and an authenticated
exact relinquishment revocation invalidate acceptance. These comments have their
own acceptance semantics; they do not count as a GitHub PR review.
The bodies bind the complete saved plan and inventory by their recomputed IDs;
the operator and reviewer must inspect that complete plan before accepting it.

Save the returned `plan` object, then call `worktree:transition:apply`
(`issue_worktree_transition_apply`) with `--plan`, `--plan-id`,
`--relinquishment-comment`, `--acceptance-comment`, and
`--authorize-transition`. Apply preserves immutable original copies and records
intent before ownership changes. Repeat the same plan and authority IDs after
interruption; pending intent blocks ordinary resume, verification, publication,
review, merge and re-registration. Active resume requires fresh current
verification and review. Terminal transition witnesses permanently restrict
ordinary source operations.

When a ready issue remains open after a prerequisite PR merges, `develop` or
`issue_develop` can continue its existing worktree under the same preparing owner.
It requires the clean original branch and exact prior verified publication,
merge intent and native merged-PR lineage. Continuation preserves the ownership
witness and all prior receipts, clears the prior PR from the active registry row,
and resumes Project synchronization idempotently. Commit the continuation changes
before verification; the already-merged HEAD cannot produce replacement evidence.
A closed issue, different owner, stale lineage or pending/terminal transition is
refused. Source holds and runtime admission remain in force.

A clean committed descendant can also continue when the configured personal
author is the authenticated native author of the prior merged PR. The historical
preparing label remains evidence. `develop` first saves an exact private plan and
refuses to change custody until the native issue contains the complete operator
authority body and independent configured reviewer-App acceptance. The saved
templates bind the current source, configuration, installed runtime admission,
original row, historical receipts and new owner. Set the acceptance template's `authorityCommentId` to the operator
comment's native ID. The operator attests that all other launchers and writers
are quiescent and remain excluded through recovery. The existing writer slot
must be absent; this flow never recovers or terminates an unknown writer.

Repeat `develop` or existing-issue `start` after interruption. Recovery checks
the same pinned native comments, revocation, original bytes and exact original
or replacement row before completing. Other mutations, including metadata
resume, remain fenced while intent is pending. Completion retains the old
witness and receipts, creates a distinct owner witness when identity changes,
and permits fresh verification of the descendant and later ordinary commits.
Historical approval supplies no current verification, review or hold release.

Native issue metadata updates may target a legacy registered issue without
adopting its worktree. The authenticated author and admitted runtime still apply,
and canonical registry/schema, duplicate-owner and complete transition checks
remain mandatory. Metadata updates preserve source, registry, ownership witnesses
and delivery receipts; source lifecycle operations still require attested custody.

Terminal disposition defaults to `retain`, preserving source and all holds.
Supply native retained-hold comment IDs with `--retained-holds`. `remove` requires
an independently accepted personal assertion that no holds remain, exact native
merged-result lineage and the existing non-force clean-source cleanup proof.
Source delivery never releases a hold, retires a legacy protocol, changes a host
launcher or admits a shared runtime. Transition artifacts remain under the
existing private Git `ai-delivery/worktree-owners` evidence directory; no second
worktree registry is introduced.

`verify` classifies a clean Git base/head range, runs only the stages selected by the repository policy, and persists content-addressed private checkpoints under the Git common directory. It reuses compatible complete stages and rejects corrupt or stale inputs. Selected stage commands run asynchronously without a total-duration deadline. Bounded JSON status lines on stderr show the current stage and command, completed/reused/remaining stage and command counts, elapsed time, captured output bytes, executed-command throughput, command age and time since completed work. They appear when a command starts and every five seconds while it runs; bounded resource observations are reported at each sample. A quiet command remains cancellable and diagnosable from its age and unchanged completion counts. Process activity and output do not establish useful progress; only complete receipts and the exact-source aggregate are checkpoints.

For independent component reuse, export `schemaVersion: "RepositoryDeliveryPolicy@2"` from the existing policy. Each selected stage supplies both its ordered `semanticInputKeys` and matching explicit `semanticInputs`, for example:

```js
{
  id: "unit",
  commands: [{ label: "unit", argv: ["npm", "run", "test:unit"] }],
  dependsOn: [],
  resourceClass: "focused_node",
  semanticInputKeys: ["unit-source"],
  semanticInputs: [{ key: "unit-source", digest: unitSourceDigest }],
}
```

The classifier owns the digest values and must include every relevant source, configuration, schema, dependency and input artifact for that stage. The runtime never derives component values from key names. Version 2 stage inputs also bind the selected commands and dependencies, policy/configuration bytes, policy producer, installed runner code and resolved dependency manifests, runtime environment, worktree identity, upstream receipt IDs and selected attestation artifacts. Unchanged compatible stages can survive an unrelated Git commit; a changed component invalidates its stage and dependents. Every final aggregate binds the current exact classification and verifies all selected stage proofs. `RepositoryDeliveryPolicy@1` remains supported with its original whole-range reuse contract; its receipts are never upgraded into component evidence. Classification, stage input, receipt and aggregate version 2 evidence uses separate stage/aggregate storage. Immutable command output remains content addressed.

Verification holds one file lease per worktree and durably records its writer and observed command process identities. A second writer in the same worktree is rejected before execution. Separate worktrees can overlap, including at the same head, with separate stage inputs and mutable manifests. Callers must first qualify their commands' CPU, memory, disk, I/O and shared-file/service requirements; a resource class alone grants no shared-resource exclusivity. The runtime adds no global executor cap. On retry after writer interruption, it refuses live or unknown ownership and reconciles only the recorded command group and observed descendants before reusing compatible completed stages. A launch interrupted before command identity was recorded requires explicit reconciliation. Process identity observation is required on supported POSIX hosts; unavailable or ambiguous observation fails closed.

The `--admit` flag explicitly admits additional resource classes for execution. Compatible complete stages are reused only after their existing stage, artifact, command-output and applicable resource proofs are fully validated, without admitting execution of those classes. Missing or incompatible proof requires the current invocation's admission for the actual stage class before any command runs; corrupt proof remains a hard failure. This permits serial `source_only`, `model`, then `postgres_docker` invocations to reuse prior completed stages while admitting only the next class to execute. Publication creates a draft PR only after exact-head verification; a high-risk policy also requires a prepublication review artifact. Ready promotion and merge require a submitted formal review. Merge checks live blockers, checks, base/head coordinates, and the policy boundary. Repositories may require an exact base/head lease for merge.

For a bounded run, pass `--max-aggregate-rss-bytes`, `--min-free-disk-bytes`, and optionally `--max-new-output-bytes` with one or more `--output-root` paths to `verify`. `issue_verify` accepts the same values in `resourceBounds`. RSS is sampled across the observed child process tree, including observed detached descendants; free disk is checked before commands and during execution on the worktree and declared output filesystems. Positive file-size growth is sampled under the declared roots, with previously measured completed stages carried across a resume. The caller must declare every output root relevant to its allowance; aliases must resolve within those roots. The roots are relative to the issue worktree unless absolute. Unix-domain IPC sockets inside declared roots are observed as endpoints with zero regular-file payload bytes and remain counted toward the scan entry limit. Regular-file growth in every root is still measured; FIFOs and device entries remain unsupported. Output growth is separate from the 8 MiB captured stdout/stderr limit. Resource limits are opt in and do not impose a total runtime deadline.

During a running command, a previously validated, unchanged alias may temporarily lose its physical target during a rebuild. The observer checks its current identity and target ancestry, reports the path and errno, and still completes a fresh scan of all physical files in every declared root. It never substitutes an incomplete scan or an earlier byte count. A missing target does not impose a build deadline when complete output accounting remains available. Unvalidated aliases that prevent a complete scan retain the one-second observation-stall window, starting after the first failed scan rather than before it. Cancellation, RSS and disk checks continue. Baseline and final scans remain strict; permanent broken links, cycles, escaping aliases and changed identities fail closed. Failed commands retain captured stdout/stderr in the existing private content-addressed command-output store, with its digest, actual exit status and first/last filesystem observation in the failure diagnostic. Output still buffered inside a killed child is unavailable to the runner.

Real filesystem-negative tests can use `withVerificationFilesystemFixture` from `@aviaratech/ai-delivery` (or its `agent` export):

```js
import { withVerificationFilesystemFixture } from '@aviaratech/ai-delivery';

await withVerificationFilesystemFixture(async () => {
  // Create the real negative fixture inside a declared output root.
  try {
    // Assert the actual reader rejects it without blocking.
  } finally {
    // Remove every negative fixture before returning or throwing.
  }
});
```

Bounded verification supplies an inherited, run-owned filesystem coordination capability. The helper serializes the fixture's lifetime against strict scans of every declared root; nested verification and runtime setup join the same boundary. Without an inherited observer the helper runs its callback normally. Malformed, foreign or stale capabilities fail closed. The callback must contain only the negative test and its teardown, and must not start verification while holding the fixture. A queued scan takes priority over new fixtures. RSS, disk, captured-log limits and cancellation continue while the scan waits; waiting observations do not claim a new filesystem measurement. A fixture that fails to release a waiting scan within five seconds is a stalled reader/teardown failure: the command is terminated through the existing identity-checked cleanup, without stealing the live fixture lease. This is an operation-specific observation-stall bound, not a verification runtime limit. Successful commands and fully cached resumes receive fresh strict scans; ordinary or leaked unsupported entries still fail. Abrupt termination can prevent callback teardown; leaked fixtures remain visible and fail subsequent verification. After existing writer recovery confirms command quiescence, only validated abandoned control metadata from that worktree is retired. No output roots, unsupported file kinds or regular-file byte growth are exempted.

Bounded stage checkpoints bind the limits and sampled observations. Older unmeasured stages and stages with different limits rerun. Current manifests use `ai-delivery.run@3`, bind the worktree and producer, and live under `runs@2/<worktree-digest>/<head>.json`. Bounded manifests also record limits, sample count, and sampled RSS, output, and disk extrema. Historical run versions 1 and 2 remain historical and are available for merged-issue recovery; current publication requires current-producer verification. `processCoverage: "observed-processes-only"` means a passing aggregate is not proof that every detached descendant was drained. A descendant that detaches and closes inherited pipes between samples can evade observation; a pipe holder that prevents command closure fails with unverified cleanup and no checkpoint. Output roots must be canonical and nonoverlapping. Resolvable aliases such as npm `.bin` links may point only within the declared roots; aliases are not traversed or counted twice, and growth of their physical targets remains measured. Escaping, broken and cyclic links fail closed. Output baselines are retained across retries, including failed stages. They are range scoped: a changed baseline regenerates the measured stage proof. Consumers must confirm their command graph remains observable and declare all relevant output roots; this contract does not assert ownership of undeclared output locations or other concurrent writers.

A reviewed policy transition can be verified and published before activating
its new configuration. For `verify`, issue-bound PR operations, and `finish`,
invoke from the primary checkout or the exact registered issue checkout. The
dispatcher selects that issue's witnessed, clean source for operation policy,
configuration and author/reviewer roles. Runtime admission continues to bind
the unchanged primary controller configuration and installed CLI/MCP bytes.
Controller metadata discovery uses the configured source author; a review
operation still authenticates independently as the configured reviewer App.
Both contexts must select the same repository and share its Git common
directory. Tracking and worktree preparation continue to use their caller's
configuration and admission.

Use the candidate's configured identities and obtain fresh verification and,
when required, prepublication review for its exact base, head, tree and
configuration. Formal review and ready promotion recheck that candidate
configuration against the verified classification. Source drift, a changed
remote base, missing ownership or
unadmitted controller bytes/configuration reject the operation. The selected
author credential makes the normal push and PR; formal review, counted approval
and exact-head merge checks remain required. Publication does not activate the
candidate configuration or rewrite runtime admission. After merge, the
consumer's supported installation/admission process owns that transition.
If cleanup has removed the checkout or registry row, merge/finish recovery uses
the admitted primary context and retained terminal receipts with remote
readback; it does not reconstruct source configuration or issue another merge.

For recovery, inspect the original issue/PR, worktree registry and exact source
head before retrying. A `created-not-started` response includes `safeResume`
arguments; use those arguments unchanged to resume the known issue. `verify`
reuses compatible stage checkpoints after interruption. If code, config, policy,
the selected stage inputs or a checkpoint changes, regenerate the affected
proof. A stopped or failed publish/finish must be read back before retrying;
never infer completion from a timed-out command. Task assignment and model
routing belong to a separate orchestrator, not this CLI.

## Bounded issue source phases

The root and `@aviaratech/ai-delivery/agent` exports provide
`withIssueSourcePhase(input, async context => { ... })` for an expressly
authorized source graph in an existing registered issue worktree. The input
binds its exact row and ownership witness, configured authenticated author,
admitted executing SDK, primary controller HEAD/configuration, and separate
candidate HEAD/index/dirty files/configuration. Declare frozen caller and input
artifact digests, resolved command executables/argv/cwd, effective environment
digest and overrides, completion artifacts, disjoint output roots and fixed
RSS/output/disk bounds. Environment values stay in memory; records contain its
digest. The selected SDK's producer commit and the consumer controller HEAD
are separate identities.

`identity` selects the configured authenticated author. Historical worktree
custody may name a different principal: the exact canonical row digest and
ownership witness remain bound and unchanged throughout the phase. The receipt
binds that row separately from its authenticated actor; entering a source phase
does not transfer custody or alias those principals.

Inside the callback, prepare owned metadata and `await context.run(index)` for
every command, in order, once. The context exposes read-only source,
controller, authenticated actor and input identities. It permits one active
command and expires when the callback settles. An unawaited command cancels
the phase and triggers identity-bound descendant cleanup. This is a trusted
cooperative callback: use its AbortSignal and issue all subprocesses through
`run`. JavaScript is not sandboxed. Source must preserve the exact initial
snapshot or produce the one declared commit with its exact parent/tree and
clean postconditions. Normal commit hooks remain enabled.

The existing writer fence is published before lengthy validation/scans. The
same runner accounts for the controller and owned descendants, captured logs,
callback output and SDK metadata under one original cumulative physical
baseline. New command calls cannot replace the graph, environment, roots or
allocation. Cancellation and lock compromise cancel owned work; process
cleanup, output accounting, writer release and lock release failures remain
distinct. Completion is sealed only after accounting and confirmed release.
The shared writer admission check continues to exclude other worktree writers
while this source-phase record is unsealed, including the release-to-seal interval.

The finite private `ai-delivery.source-phase@1` record is stored beneath the
Git common directory's `ai-delivery/receipts/source-phase@1`, keyed by worktree
and complete input digests. A compatible completed record can be returned
without entering the callback or replaying commands after validating source,
producer, admission and artifacts. A terminal `failed-quiescent` or
`rejected-before-work` attempt can be followed only by an expressly authorized
new input naming its exact predecessor phaseId/recordId, original baselineId
when present, and authorization digest in `reconciliation`. Retain original
source/runtime/input and allocation bindings and all output/bootstrap charges;
corrected rejected inputs supply no reusable proof. Intermediate command
results are never replay checkpoints. A missing or mistyped predecessor can be
corrected without discarding its rejected record: validated retention edges
carry every rejected sibling's bootstrap charge, separately from the requested
reconciliation and any reusable source/runtime proof. Every attempt inherits
the retained original allocation and charges prior attempts before checking
work authorization. Rejected requests cannot enlarge that allocation or change
its roots. Exhaustion remains unresolved and refuses another record or writer
claim. Interrupted intent, uncertain commits,
changed frozen inputs or unconfirmed release remain unresolved and refuse a
new attempt; the API supplies no previous-process recovery or force-unblock.

Its receipt proves this bounded operation only. Canonical verification,
independent acceptance, scientific holds and receiving runtime selection keep
their existing owners and checks.

## Compatibility contract

The MCP input and result contract is `ai-delivery.mcp@1`, exported as `AI_DELIVERY_MCP_CONTRACT_VERSION`. It retains the 13 `issue_*` tool names. Each tool rejects unknown fields at the request boundary. `issue_create` accepts a title with optional body, Issue Type, Points, Priority, taxonomy labels, milestone, parent and blockers; it returns `{body, created: {number, title, url}, routing}`. A linked parent is read back and cleared of Points. `issue_start({issueNumber})` always checks readiness and prepares that existing issue; `develop` gates only preparation of a newly created issue. New starts default to 2 Points. `resumeCreated` requires both `issueNumber` and `develop: true` and never creates a second issue. Immediate creation and development preflights readiness before creation and returns `ai-delivery.issue-start-registration@1` with `status: "started"` or a `created-not-started` failure and exact `safeResume` arguments. The CLI prints that recovery JSON and exits nonzero for `created-not-started`. Scratch starts derive safe names from the request or title and return the branch and worktree path. `repo` on create, start and ready check, or global CLI `--repo`, must match the repository selected by the checkout's validated Git remote; a mismatch fails before a GitHub call.

`issue_update` returns authoritative issue readback and synchronizes configured Project status from live native blockers. Closed issues and Done items remain Done; removing the last unresolved blocker returns to Todo. To park execution while retaining a worktree, use `ai-delivery update --issue 17 --park` or `issue_update({issueNumber: 17, park: true})`; status becomes Todo, or Blocked while native blockers remain. Unrelated metadata edits preserve parked presentation. Resume explicitly with `develop`/`issue_develop` or an existing-issue start, which still requires readiness; worktree presence never establishes active execution. `issue_info` returns current native metadata, parent, blockers, Project state and registered worktree; `issue_ready_check` returns deterministic admission and reasons; `issue_develop` and `issue_worktree_create` return registered worktree rows. `issue_verify` returns classification, aggregate, manifest and publication evidence IDs, plus the sampled resource summary when limits were supplied. `issue_pr_create` returns the PR number, URL and bound publication evidence ID, plus route evidence or the live review state on ready promotion; `issue_pr_info` returns number, state, exact head/base, draft flag, author login and URL. `issue_pr_review` returns an exact-head submitted review receipt and live required-review state, `issue_pr_merge` a durable merge receipt, and `issue_finish` returns the merge SHA and successful issue/cleanup readback. CLI and MCP call the same owners for these tools.

The CLI also exposes native relationship reads (`parent`, `subissues`, `blockers`), registry reads and clean registered PR/standalone cleanup (`worktrees:list`, `worktrees:status`, `worktrees:cleanup`), and PR reads and exact-head selected-author checkout (`pr:list`, `pr:checks`, `pr:checkout`). `pr:checks` includes GitHub's current review decision. A cleaned PR worktree can be reopened when its retained branch still matches the remote head. `migrate:legacy-issues --input-file` produces an offline `ai-delivery.legacy-issue-migration@1` plan without live writes. `metrics velocity --json` reads completed local delivery records and returns `ai-delivery.velocity-report@1` with buckets for configured Points; unknown blocker and review measurements remain null. `finish` can confirm completion after a lost response by matching the exact merge receipts, delivery record and live issue/Project state. Installing the package never migrates active runtime state automatically.

## Contributor checks and release

Use Node 24.21.0 and npm 11.19.0. `npm ci` installs the single committed lockfile; `npm run checks` is the canonical local gate and runs Oxfmt, native Oxlint with `oxlint-tsgolint`, strict TypeScript, a compiled build, and Vitest over the emitted `dist/**/*.test.js` files. The compiled test target preserves CLI child-process and package-file assertions. `npm run build` can be run separately before packing. Tests cover discovery, identity, admission drift, lifecycle receipts, interruption/recovery, cleanup, and plugin boundaries with synthetic repositories. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local commands and release prerequisites.

The standalone lint config enables native error, promise, unsafe-value, and explicit-type checks. TypeScript uses exact optional properties, checked indexed access, explicit overrides, return/fallthrough, and unused-symbol checks. Tests and review cover the delivery behavior boundary.

Installing the package does not switch an existing consumer. Run `npm run checks`, `npm run build`, and `npm pack --dry-run` before release.
