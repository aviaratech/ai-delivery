# ai-delivery

Generic GitHub issue and pull request delivery with Git/GitHub discovery and a source-controlled `RepositoryDeliveryPolicy@1` module. Routing overrides are optional. The package provides one `ai-delivery` CLI, one stdio MCP server, and thin plugin assets in `plugins/ai-delivery`.

The package contains no repository-specific policy, credential, model, or deployment configuration. A consuming repository owns its issue taxonomy, author and reviewer credentials, native Project fields, delivery stages, and phase constraints. The runtime refuses an untracked override file or a missing or untracked policy module. Credentials and delivery policy remain explicit.

## Availability and installation

Install the versioned package from npm or a reviewed package archive. The
consuming repository must run its own configuration and runtime-admission
procedure before any lifecycle write.

```sh
node --version # 24.21.0
npm --version  # 11.19.0
npm install --save-dev @aviaratech/ai-delivery@0.3.1
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
`--identity personal --personal-auth` override remains explicit; configure the
personal author role above for complete PR delivery with matching review
artifacts and policy evidence.

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

Inspect the result before issuing a new runtime admission:

```sh
npx ai-delivery --repo-root /absolute/path/to/consumer --identity host-author config:resolve
npx ai-delivery --repo-root /absolute/path/to/consumer --identity host-author pr:create --issue 17 --dry-run
```

These reads return `routing` (repository, Project/field/option identities and
selection source), `configDigest`, effective author and reviewer actors,
credential sources, reviewer repository read access, and available branch-rule
evidence. A partial or unknown rule view stays labeled unknown; it does not
require broader administrator access. Before publication, resolve a same-actor
error or missing configured credential. After `issue_pr_review`, inspect its
`reviewState` and `pr:checks`. If GitHub still reports `REVIEW_REQUIRED`, inspect
the active rule and obtain a qualifying independent approval; repeating the
same App review cannot resolve that state. CLI and MCP use the same asynchronous
`loadDeliveryConfig` resolver. `issue_create` and `issue_info` also expose the
resolved routing. An MCP server stays bound to its startup checkout; use separate
bindings or explicit CLI checkout selection for multiple repositories.

The consumer installer must issue a private `ai-delivery.runtime-admission@2`
record at `<git-common-dir>/ai-delivery/runtime-admission.json`. It binds the
verified archive, package version, capability 2, actual CLI/MCP/plugin bytes and
paths, repository and the resolver's `configDigest`. That digest includes the
policy/settings source, validated effective roles and checks, optional overrides
and effective discovered routing;
**do not substitute a JSON-file hash**. Drift in the Project, fields, options,
policy, overrides or installed bytes invalidates admission and verification
receipts. Resolution never refreshes its own admission during a mutation.

To migrate from 0.1: move `roles` and `commandPolicy` into the existing policy's
`deliverySettings` export; replace the old JSON with only necessary overrides
(or remove it when using the default policy filename); await `loadDeliveryConfig`
in installer integrations; review the resolved destination and reissue capability-2
admission using its digest. Do not upgrade old receipts into approvals. Existing
rows in `.issue-cli/worktrees.json` remain with their original runtime unless
they already have an exact `ai-delivery.worktree-owner@1` witness. Installing this
package never adopts or switches an active legacy writer.

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

The `--admit` flag explicitly admits additional resource classes. Publication creates a draft PR only after exact-head verification; a high-risk policy also requires a prepublication review artifact. Ready promotion and merge require a submitted formal review. Merge checks live blockers, checks, base/head coordinates, and the policy boundary. Repositories may require an exact base/head lease for merge.

For a bounded run, pass `--max-aggregate-rss-bytes`, `--min-free-disk-bytes`, and optionally `--max-new-output-bytes` with one or more `--output-root` paths to `verify`. `issue_verify` accepts the same values in `resourceBounds`. RSS is sampled across the observed child process tree, including observed detached descendants; free disk is checked before commands and during execution on the worktree and declared output filesystems. Positive file-size growth is sampled under the declared roots, with previously measured completed stages carried across a resume. The caller must declare every output root relevant to its allowance; symbolic links inside those roots fail closed. The roots are relative to the issue worktree unless absolute. Output growth is separate from the 8 MiB captured stdout/stderr limit. Resource limits are opt in and do not impose a total runtime deadline.

Bounded stage checkpoints bind the limits and sampled observations. Older unmeasured stages and stages with different limits rerun. Current manifests use `ai-delivery.run@3`, bind the worktree and producer, and live under `runs@2/<worktree-digest>/<head>.json`. Bounded manifests also record limits, sample count, and sampled RSS, output, and disk extrema. Historical run versions 1 and 2 remain historical and are available for merged-issue recovery; current publication requires current-producer verification. `processCoverage: "observed-processes-only"` means a passing aggregate is not proof that every detached descendant was drained. A descendant that detaches and closes inherited pipes between samples can evade observation; a pipe holder that prevents command closure fails with unverified cleanup and no checkpoint. Output baselines are retained across retries, including failed stages. They are range scoped: a changed baseline regenerates the measured stage proof. Consumers must confirm their command graph remains observable and declare all relevant output roots; this contract does not assert ownership of undeclared output locations or other concurrent writers.

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

## Compatibility contract

The MCP input and result contract is `ai-delivery.mcp@1`, exported as `AI_DELIVERY_MCP_CONTRACT_VERSION`. It retains the 13 `issue_*` tool names. Each tool rejects unknown fields at the request boundary. `issue_create` accepts a title with optional body, Issue Type, Points, Priority, taxonomy labels, milestone, parent and blockers; it returns `{body, created: {number, title, url}, routing}`. A linked parent is read back and cleared of Points. `issue_start({issueNumber})` always checks readiness and prepares that existing issue; `develop` gates only preparation of a newly created issue. New starts default to 2 Points. `resumeCreated` requires both `issueNumber` and `develop: true` and never creates a second issue. Immediate creation and development preflights readiness before creation and returns `ai-delivery.issue-start-registration@1` with `status: "started"` or a `created-not-started` failure and exact `safeResume` arguments. The CLI prints that recovery JSON and exits nonzero for `created-not-started`. Scratch starts derive safe names from the request or title and return the branch and worktree path. `repo` on create, start and ready check, or global CLI `--repo`, must match the repository selected by the checkout's validated Git remote; a mismatch fails before a GitHub call.

`issue_update` returns authoritative issue readback; `issue_info` returns current native metadata, parent, blockers, Project state and registered worktree; `issue_ready_check` returns deterministic admission and reasons; `issue_develop` and `issue_worktree_create` return registered worktree rows. `issue_verify` returns classification, aggregate, manifest and publication evidence IDs, plus the sampled resource summary when limits were supplied. `issue_pr_create` returns the PR number, URL and bound publication evidence ID, plus route evidence or the live review state on ready promotion; `issue_pr_info` returns number, state, exact head/base, draft flag, author login and URL. `issue_pr_review` returns an exact-head submitted review receipt and live required-review state, `issue_pr_merge` a durable merge receipt, and `issue_finish` returns the merge SHA and successful issue/cleanup readback. CLI and MCP call the same owners for these tools.

The CLI also exposes native relationship reads (`parent`, `subissues`, `blockers`), registry reads and clean registered PR/standalone cleanup (`worktrees:list`, `worktrees:status`, `worktrees:cleanup`), and PR reads and exact-head selected-author checkout (`pr:list`, `pr:checks`, `pr:checkout`). `pr:checks` includes GitHub's current review decision. A cleaned PR worktree can be reopened when its retained branch still matches the remote head. `migrate:legacy-issues --input-file` produces an offline `ai-delivery.legacy-issue-migration@1` plan without live writes. `metrics velocity --json` reads completed local delivery records and returns `ai-delivery.velocity-report@1` with buckets for configured Points; unknown blocker and review measurements remain null. `finish` can confirm completion after a lost response by matching the exact merge receipts, delivery record and live issue/Project state. Installing the package never migrates active runtime state automatically.

## Contributor checks and release

Use Node 24.21.0 and npm 11.19.0. `npm ci` installs the single committed lockfile; `npm run checks` is the canonical local gate and runs Oxfmt, native Oxlint with `oxlint-tsgolint`, strict TypeScript, a compiled build, and Vitest over the emitted `dist/**/*.test.js` files. The compiled test target preserves CLI child-process and package-file assertions. `npm run build` can be run separately before packing. Tests cover discovery, identity, admission drift, lifecycle receipts, interruption/recovery, cleanup, and plugin boundaries with synthetic repositories. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local commands and release prerequisites.

The standalone lint config enables native error, promise, unsafe-value, and explicit-type checks. TypeScript uses exact optional properties, checked indexed access, explicit overrides, return/fallthrough, and unused-symbol checks. Tests and review cover the delivery behavior boundary.

Installing the package does not switch an existing consumer. Run `npm run checks`, `npm run build`, and `npm pack --dry-run` before release.
