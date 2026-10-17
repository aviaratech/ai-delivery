# ai-delivery

GitHub issue and pull request delivery through a CLI, a stdio MCP server and a self-contained Codex/Claude Code plugin. Explicit repository calls work from any directory. The runtime reads operator-owned JSON and GitHub metadata; it never imports a consuming repository's policy or runs its checks. Run contributor checks and prepare worktrees through the host's normal tools.

## Installation and runtime

Use Node 24.21.0 and npm 11.19.0 for the CLI, MCP server and contributor checks. Public library consumers also support Node 26.2.0. Set `AI_DELIVERY_NODE26_EXECUTABLE` to that actual executable for contributor checks. Install a qualified published version or reviewed archive, then use the [plugin guide](plugins/ai-delivery/README.md) for native installation.

```sh
ai-delivery --repo example/widget info --issue 17
ai-delivery mcp:serve
```

## User configuration

Create `~/.config/aviaratech-ai/ai-delivery.json`, or set `AI_DELIVERY_CONFIG` to an absolute operator-owned JSON path. Required settings are `schemaVersion`, `roles.author`, `roles.reviewer`, `project`, and `checkoutRoots`; validation errors name the missing setting. A consuming repository needs no ai-delivery files.

```json
{
  "schemaVersion": "ai-delivery.user@1",
  "roles": {
    "author": {
      "identity": "host-author",
      "authSource": "personal",
      "credentialEnv": { "token": "GH_TOKEN" }
    },
    "reviewer": {
      "identity": "delivery-reviewer",
      "credentialEnv": {
        "appId": "DELIVERY_REVIEWER_APP_ID",
        "installationId": "DELIVERY_REVIEWER_INSTALLATION_ID",
        "privateKeyPath": "DELIVERY_REVIEWER_KEY_PATH"
      }
    }
  },
  "project": 7,
  "checkoutRoots": ["/absolute/path/to/clones"]
}
```

An App author uses the same `credentialEnv` shape as the reviewer. Roles and credential environment names must be distinct. Credential values and private keys remain outside source control. A configured personal author uses its named token variable. With the conventional `GH_TOKEN` reference **absent**, it instead uses the existing active personal account from GitHub CLI `gh` for `github.com`. A present empty, malformed or expired token fails without switching accounts. A custom reference such as `DELIVERY_AUTHOR_TOKEN` always requires that exact value; its absence does not select a machine session. Unrelated `GITHUB_TOKEN` values do not satisfy either configured reference. The optional `--identity` or `AI_DELIVERY_IDENTITY` override must select the command's configured role; neither is needed for normal operation. The explicit legacy `--identity personal --personal-auth` override is limited to development access diagnosis under an App author configuration; it requires an explicit token and does not use a missing-token machine fallback. Publication requires the configured author.

The machine route uses `gh auth status --hostname github.com --active --json hosts`, validates the selected account's state, then privately obtains that exact user's credential through `gh auth token --hostname github.com --user <active-user>`. An actual authenticated user read must match the selection. Repository discovery and command execution retain that account; failed identity/access never selects another account. Inactive accounts with errors do not invalidate a healthy active user. Only required non-secret home/PATH/gh configuration selectors reach `gh`; token overrides, debug flags and unrelated credentials are excluded. No login, switch, refresh, credential-store scraping or persistent configuration change occurs. The reviewer still uses its distinct configured App, with no personal-session fallback.

`gh` must be executable on the running process's PATH and able to access its existing session. A terminal login does not prove that a Codex or Claude GUI process can find `gh` or use its keyring. `config:resolve` reports the selected route/executable and authenticated actor, or a safe actionable refusal. Default plugin doctor does not inspect or authenticate the session. This package currently supports `github.com` repositories; enterprise URLs or a conflicting `GH_HOST` refuse rather than silently using another host. No write probe or permission grant is performed, and a successful identity/repository read does not guarantee every later write or counted App approval.

The explicit organization Project number selects a compatible writable Project. Optional `pointsField`, `priorityField`, `statusField`, four `statuses` names (`todo`, `inProgress`, `blocked`, `done`), and `issueTypes` customize discovered metadata. Defaults are Points, Priority, Status and Todo/In Progress/Blocked/Done. IDs, option catalogs and issue types come from GitHub. This runtime supports github.com organization repositories and native organization single-select Points/Priority fields bound into the selected Project.

Every remote MCP tool accepts `repo: "owner/name"`; the CLI uses global `--repo`. Without a selector, the launch checkout's `origin` supplies the destination. Explicit remote calls never probe launch-directory Git or checkoutRoots. One MCP server can switch A → B → A without restart. Tool and server selectors that disagree are refused.

Local runtime setup and legacy transition calls select a matching `origin` per invocation. A matching current checkout wins; otherwise `checkoutRoots` may contain exact clone roots or parents whose immediate directories contain clones. Duplicate physical matches are collapsed. Zero or multiple matches refuse with a specific diagnostic; use `--repo-root` to select the intended matching clone. Git probes disable repository hooks, filters, fsmonitor and external diff/text conversion. Remote delivery never performs a checkout, push, or worktree mutation.

## GitHub-gated lifecycle

```sh
ai-delivery --repo example/widget config:resolve
ai-delivery --repo example/widget ready:check --issue 17
ai-delivery --repo example/widget start --issue 17
# Prepare a host-owned worktree, implement, run repository checks, commit and push.
ai-delivery --repo example/widget pr:create --issue 17 --body-file ./pr-body.md --dry-run
ai-delivery --repo example/widget pr:create --issue 17 --body-file ./pr-body.md
# Obtain an independent review of the exact remote PR head and diff.
ai-delivery --repo example/widget pr:review --issue 17 --pr 23 --artifact ./review-artifact.json
ai-delivery --repo example/widget pr:create --issue 17 --ready
ai-delivery --repo example/widget pr:checks --pr 23
ai-delivery --repo example/widget finish --issue 17 --pr 23 --reviewed-head <reviewed-sha>
```

`start` creates or reuses a GitHub-linked branch from the repository's default branch. A ready open issue with no unresolved native blockers is explicitly activated: the selected Project item becomes In Progress (using configured field/option names), with exact readback before the Started journal. An already active item is reused; missing membership is added only for that issue. Closed issues, parked drafts, unresolved blockers and archived Project items refuse activation. Info, body-only edits, PR dry runs and host worktree preparation do not activate work.

It can create a tracking issue first, or resume a known partially created issue with `--resume-created`; recovery returns the exact known issue and safe arguments without creating another issue.

If an existing issue's branch, Project status or journal operation fails or its response is uncertain, `start-incomplete` returns the known issue, failure phase and `safeResume.arguments`; CLI exits nonzero. Retry those arguments through `issue_start` (or `start --issue <number> --branch <branch>` when returned). Recovery rechecks current readiness, linked branches, Project membership/status and the authored journal before continuing, without creating another issue, branch or journal. Newly created issues retain `created-not-started` recovery. Only incomplete tracking returns `resumeCreated: true` with tracking fields; later start-stage recovery selects the known issue/branch and preserves subsequent native edits and parking.

Hosts own local worktree preparation and cleanup. PR creation accepts any non-empty body, appends the issue closing reference when absent, and reuses the matching remote branch/PR. Merged completion uses GitHub issue association even after branch deletion. Existing repository labels are accepted; an unknown label is refused before issue mutation.

For a new read-only investigation, the host first creates the linked `issue/N` worktree at the matching clone's exact `.worktrees/issue-N` path. Before investigating, explicitly register its unchanged current default commit:

```sh
ai-delivery --repo example/widget --repo-root /clone start --issue 17 \
  --investigation-worktree /clone/.worktrees/issue-17 --expected-head <initial-sha>
```

This author operation records prospective commit/tree, physical worktree identity, canonical registry custody and a native preparation acknowledgement. It creates no branch or worktree and refuses existing legacy custody. Historical investigations without this preparation cannot be adopted retrospectively.

After independently reviewing the complete result, preserve it in a private regular file outside the worktree. The issue must already be closed with reason `completed`, with no PR associated with its linked branch. Inspection prints the exact operator authority body and, when its comment ID is supplied, the configured-App acceptance body:

```sh
ai-delivery --repo example/widget --repo-root /clone finish --issue 17 \
  --investigation --result /retained/result.txt --dry-run
ai-delivery --repo example/widget --repo-root /clone finish --issue 17 \
  --investigation --result /retained/result.txt --authority-comment <operator-comment> --dry-run
ai-delivery --repo example/widget --repo-root /clone finish --issue 17 \
  --investigation --result /retained/result.txt \
  --authority-comment <operator-comment> --acceptance-comment <app-comment>
```

Completion consumes existing whole native comments from the configured personal operator and distinct configured reviewer App. These bind the preparation, exact result bytes, unchanged commit/tree and removal scope, including producer quiescence and continued exclusion of writers. This path supplies no non-PR App acceptance writer; unavailable authentic acceptance is a refusal, never a local approval substitute. Keep the result, native acceptance and producer exclusion available through interruption and resume.

Run completion from outside the investigation worktree. Dirty, untracked or ignored files, `assume-unchanged` or `skip-worktree` index entries, new commits (including same-tree commits), changed native refs, ambiguous or foreign custody and retained verification writers refuse removal. PR/merge options are incompatible with investigation mode. A durable intent preserves the result, native authority and exact registry beforeimage before non-force Git removal. Resume the same command and evidence after an interruption; unexplained absence or recreated worktrees refuse. Exact disk/Git/registry postconditions seal completion. The branch, private evidence and unrelated registry entries remain retained; ordinary source delivery still requires its full merged-PR proof.

Use explicit `--non-closing` on each PR command when delivering a partial fix while its issue remains OPEN. The default closing lifecycle above is unchanged. A non-closing body begins with exactly `References owner/repository#number` on its first line. Creation adds this line to the supplied body; inspection, review, promotion and merge require it to remain unchanged in meaning.

```sh
# An existing author-owned PR can transition its body only with an exact selector.
ai-delivery --repo example/widget pr:create --issue 17 --pr 23 --non-closing --body-file ./partial-body.md --dry-run
ai-delivery --repo example/widget pr:create --issue 17 --pr 23 --non-closing --body-file ./partial-body.md
ai-delivery --repo example/widget pr:info --issue 17 --pr 23 --non-closing
ai-delivery --repo example/widget pr:review --issue 17 --pr 23 --non-closing --artifact ./review-artifact.json
ai-delivery --repo example/widget pr:create --issue 17 --pr 23 --non-closing --ready
ai-delivery --repo example/widget pr:merge --issue 17 --pr 23 --non-closing --strategy squash --reviewed-head <reviewed-sha> --dry-run
```

This mode requires complete native GitHub cross-reference evidence from the configured author, identifying the exact canonical issue and PR with `willCloseTarget: false`, plus complete empty native closing associations and the OPEN issue's unchanged title/body. The event establishes a server-recorded historical mention; it does not prove a current revocable Development link. Current body intent supplements that evidence and never replaces it. Missing, unauthorized, conflicting, truncated or moved evidence refuses delivery. Equivalent duplicate observations do not create additional ownership. New PRs still require native issue-branch linkage; `--pr` selects only an existing PR and never creates a replacement.

A closing-to-non-closing metadata transition is a narrow exception: with explicit issue/PR/body selection, the author may remove a fully proven intended-only native closing association by updating the body once. Exact PR identity, title, draft/open state, head/ref/base and OPEN issue criteria must remain unchanged; the post-readback must establish native non-closing reference proof and empty closing associations before any delivery action. Dry-run reports a pending transition, not verified non-closing state. Missing closing proof or an already-empty stale body cannot use this exception. An already valid non-closing PR is reused without another body update.

Non-closing delivery refuses closing directives in the current PR title/body and every introduced commit message, including other issues/repositories. Squash is required, with explicit safe title/message sent to GitHub. Counted independent exact-head App approval, required checks, blockers, current default base and CLEAN expected-head merge guards still apply. `finish --non-closing` refuses before any lifecycle call; this mode never closes the retained issue or changes its Project to Done. GitHub does not atomically lock issue intent or external edits with promotion/body/merge: failed acknowledgements or post-read drift require read-only reconciliation, never a blind mutation retry or reopening an issue.

If GitHub creates a draft but association verification fails, the diagnostic reports the created PR identity and the unresolved post-publication phase. Inspect that exact PR read-only before any further action; creation is not repeated to repair an association. A body containing closing words alone never proves the native association.

For a new issue, `start --request-id <stable-id>` records inert retry markers in its body. Retry the same request after an unknown response; matching remote state is recovered, while conflicting intent or duplicate matches refuse. Without an explicit ID, identical tracking inputs share a deterministic retry identity. Supply a new ID for a separate issue with identical inputs. A retry search beyond 2,000 issues refuses and asks for the known issue number. `pr:create --head <branch>` selects an existing linked branch when an issue has several.

Formal review requires a validated independent artifact and the configured reviewer App. The artifact binds author/reviewer identities, exact commit/tree and complete changed-path digest. The review body retains the full artifact and its digest so merge can verify the original binding even if GitHub remaps a review's commit ID after a rebase. A matching remote review is reused; conflicting actor, head, state or duplicate artifact markers refuse. Submission reads back the exact review ID and artifact. Reviews containing only a historical marker require a fresh review. Its new `ai-delivery.github-review@1` receipt is separate from historical local-evidence receipts. CLI `--artifact` reads a UTF-8 JSON file; MCP takes its JSON content.

An App approval does not prove that GitHub counted it. `pr:checks` exposes the live required-review decision. Merge requires one independent exact-head App review, its current readback, satisfied GitHub review requirements, no unresolved native blockers, and fresh CLEAN eligibility at the reviewed head and current base. BLOCKED, BEHIND, DIRTY, UNSTABLE, unknown state or moved head/base refuses. The server merge mutation includes the reviewed SHA. Finish confirms the intended PR merged before closing its issue, and retries from remote readback without local receipts.

The removed `develop`, `verify`, `pr:checkout`, worktree creation/cleanup and local velocity record commands are no longer public CLI/MCP workflows. Preserve existing consumer checks, controller admissions and historical custody records. Their original schemas, digest identities, writer locks and operational closure rules remain separate. The legacy transition commands remain exposed, but this runtime cannot reproduce their historical repository-policy configuration binding: CLI/MCP inspection and apply refuse without executing policy or converting records. Complete those transitions with the original controller. Explicit runtime stage/admit remain supported.

## Plugin installation and explicit runtime setup

The complete plugin is the canonical public installation for Codex and Claude
Code. It ships the skills and one MCP runtime together. Standalone MCP server
registration is a legacy setup; avoid adding a second registration alongside the
plugin. The CLI, SDK exports and underlying MCP transport remain available.

Legacy support will remain for **at least two subsequent stable releases and at
least 90 days after a qualified migration path first ships**. That release/date
anchor is currently unknown. Diagnostics and preview do not constitute qualified
migration, start the clock, or withdraw legacy support. Live migration and native
manifest qualification remain separate work under [#116](https://github.com/aviaratech/ai-delivery/issues/116).

Manage the native plugin with an explicit package version:

```sh
ai-delivery plugin install --host codex --scope user --version <published-version> --json
ai-delivery plugin doctor --host codex --scope user --json
ai-delivery plugin preview --host codex --scope user --json
ai-delivery plugin update --host codex --scope user --version <published-version> --json
ai-delivery plugin rollback --host codex --scope user --json
ai-delivery plugin remove --host codex --scope user --json
```

Use `--host claude-code` for Claude Code. Its supported scopes are `user`,
`project`, and `local`; select the project directory with the global
`--repo-root` option. Codex currently supports `user`. Install and update require
a literal version. Rollback selects the recorded previous version. The commands
keep verified version units in a private directory and use the native host's
marketplace and plugin commands to select that exact local source. Removal keeps
the managed version units for recovery and uses Claude Code's `--keep-data`.

Every command supports `--dry-run` and `--json`. Dry-run reports the target
without fetching an archive, running a native command, or writing configuration.
`preview` makes bounded configuration observations without native commands,
server startup, authentication, settings changes, backups, locks or checkpoints.
It exposes no launcher arguments, URLs, environments or permission values.
`plannedChanges` is empty and migration is refused. Unknown provenance and
unavailable configuration remain explicit; Codex table-header observations do
not resolve TOML, profiles or managed/CLI overrides. Claude custom-profile
configuration is likewise unverified. Preview never adopts an external plugin
or restores/removes a tool preference.

Doctor can also observe native-marketplace plugins when managed state is absent.
That observation does not establish ownership or permit startup of unknown
bytes. It reports bounded registration candidates and incomplete scope evidence;
the verified managed selection retains its separate integrity checks. Doctor
reports managed installation and source integrity, skills, and a direct
credential-free stdio startup check of the selected bundled MCP server. Startup
means that the server initialized and listed its tools; it does not validate
user settings, receive GitHub credentials, or authenticate either delivery role.
For an opt-in authentication check, select a repository explicitly:

```sh
ai-delivery --repo example/widget plugin doctor --host codex --scope user --check-auth --json
```

This checks settings and required process references before running the verified,
enabled plugin's selected CLI `config:resolve`. It reports authenticated actors,
repository access and visible review rules separately. Only configured credential
names and required runtime selectors reach that subprocess; an absent default
`GH_TOKEN` may use the selected machine session. Unrelated tokens and
legacy personal overrides do not. Missing or invalid inputs stop before key
access or network authentication. An eligible machine route is explicitly
authenticated through `gh` and the selected client after those gates. Dry-run
performs none of these checks.
The readback is labelled `selected_runtime_cli`; it does not prove GUI credential
propagation or counted exact-head approval. `config:resolve` remains available
for direct CLI readback; check an actual native tool call separately. The
[credential and readiness guide](plugins/ai-delivery/README.md#credentials-and-readiness)
explains the environment boundary and the evidence to retain without secrets.
Installed-version observations, a separately launched startup check and the
native conversation's loaded server version are distinct. The latter remains
unverified unless observed in that host. Use the host's surface-specific
activation guidance: [Claude Code plugin management](https://code.claude.com/docs/en/discover-plugins)
and [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
There is no blanket restart requirement or automatic activation. Installing a
plugin does not admit a consumer controller. Ordinary remote GitHub delivery
uses user configuration; explicit controller staging and admission remain
separate operations.

Migration apply, registration retirement and settings rollback are unavailable
here. They require exact authorized ownership, lossless settings preservation
and native writer exclusion/transactional guarantees. A matching name, missing
preference, changed registration or incomplete inventory cannot satisfy those
gates. No npm lifecycle cleanup or mandatory hook performs migration. Public npm
publication or a local catalog does not establish public plugin-directory admission.

First read `config:resolve` with the configured author, then stage a reviewed
local archive using its independently accepted SHA-256 and package version:

```sh
ai-delivery --repo-root /absolute/consumer --identity configured-author config:resolve
ai-delivery --repo-root /absolute/consumer --identity configured-author runtime:stage \
  --authorize-stage --archive /absolute/reviewed-package.tgz \
  --archive-sha256 sha256:<reviewed-archive-digest> --package-version 0.3.5 \
  --source-commit <clean-primary-consumer-head> --config-digest sha256:<resolver-digest> \
  --runtime-directory /absolute/private-runtimes/ai-delivery-0.3.5 \
  --max-aggregate-rss-bytes 536870912 --max-new-output-bytes 1073741824 \
  --min-free-disk-bytes 68719476736 --max-captured-output-bytes 1048576
```

Stage captures and hashes the exact reviewed archive bytes, durably retains a
private copy in its owned directory, and gives that copy to npm. The snapshot
counts toward the stage output allowance and is revalidated on completion,
reuse and admission. Stage installs production dependencies with scripts, audit
and funding disabled.
The existing setup writer samples controller-plus-children RSS throughout
preflight, installation and final validation, with checks at each awaited
preflight boundary and cancellation passed to in-flight GitHub requests.
These are sampled stop thresholds, not OS-enforced hard
ceilings. npm runs from the owned stage with explicit cache, log, user/global
configuration and temporary destinations there; lifecycle scripts cannot write
elsewhere because they are disabled. Filesystem accounting also covers the
consumer's delivery metadata and retained command evidence. The archive and
captured command output consume the output allowance. Retained command logs
default to 1 MiB; `maxCapturedOutputBytes` in the existing MCP/API resource
bounds, or the CLI flag above, selects a positive cap up to the evidence store's
8 MiB maximum. A failed command retains at most that cap. Default memory,
output and free-disk bounds remain 1 GiB, 512 MiB and 256 MiB.
Normalized bounds are part of the stage intent: changing them requires a fresh
stage directory and never replaces a completed stage silently.
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

The new resolver digest binds user settings, validated roles and discovered routing. Historical policy/configuration digests are not rewritten or relabeled as new bindings. Setup preserves source, archive, installed-byte and prior-admission compare-and-swap checks; a mismatched historical binding requires its original controller. No private runtime is activated by ordinary issue or PR calls.

Legacy transitions remain explicit preservation operations. Inspection returns exact closure gaps for unsupported bindings. Applying a supported plan still requires its immutable inventory, authenticated native personal-operator relinquishment and independent configured App acceptance, exact plan/comment IDs, writer quiescence and runtime admission. Installing this package does not adopt legacy custody or release retained holds.

## CLI and MCP contract

The remote contract is `ai-delivery.mcp@2`. CLI and MCP call the same owners. Issue listing/search preserve native filters, pagination, literal search boundaries and repository-qualified relationships. Issue updates preserve typed journals, history-before-rewrite and native reasoned closure. `issue_info.worktree` is null. Offline `migrate:legacy-issues --input-file` remains a read-only plan. Public exports expose remote delivery, metadata, digest utilities and explicit setup; removed executable policy/stage/evidence APIs are not exported.

### Synthetic tracking replay and quick reference

Pass `repo: "owner/name"` to MCP calls or global `--repo owner/name` to the CLI, including outside Git. The following operations are shipped:

| Operation | MCP tool | CLI command and key inputs |
| --- | --- | --- |
| List / search | `issue_list` / `issue_search` | `list` / `search --query <literal-text>`; native filters and pagination |
| Read / check readiness | `issue_info` / `issue_ready_check` | `info --issue N` / `ready:check --issue N` |
| Create a sized child | `issue_create` | `create --title <title> --fields-file <typed.json> --parent P --priority P2` |
| Rewrite with prior history | `issue_update` | `update --issue N --fields-file <typed.json> --preserve-history` |
| Reparent one issue | `issue_update` | `update --issue N --parent P`; repeat separately for each issue |
| Record a typed journal | `issue_comment` | See the [typed journal contract](#typed-issue-journals); the MCP call returns the authored comment identity and readback |
| Close with a reason | `issue_update` | `update --issue N --state closed --close-reason not_planned --superseded-by S` |

Typed JSON contains the issue contract fields, including Issue Type, Points, problem, outcome, acceptance and non-goals. CLI repository, parent and priority selectors use their documented flags. Inspect each result: rewrites return the preserved history comment; creation and reparenting return native readback. Reasoned closure returns `closure` evidence, supersession and the authored comment from `issue_update`; `issue_info` supplies state and Project status without the closure-reason evidence. A successful readiness check does not start an issue.

Creation includes five status fields: Ready or Draft, last updated in UTC,
next milestone (default `Not started`), native blocker numbers (or `None`),
and latest journal (`None yet`). Supply `status: {"nextMilestone":"Run checks"}`
on `issue_create`; `issue_update` also accepts display-only `status.blockers`
and `status.latestJournal`. The same objects work in CLI `--fields-file` JSON.
Status values are single lines rendered as literal text. Status-only patches
preserve every byte outside Status, including canonical data and start markers;
no-op patches keep the timestamp. Display blockers create no dependency edges:
use native `blockedBy` for those, and do not combine it with `status.blockers`.
The nonblocking body-length warning counts readable text, excludes embedded
issue-data, and triggers strictly above 4,000 characters.

`preserveHistory` controls an authored, exactly read-back snapshot of the prior
title/body before a rewrite. `retainLegacyBody` independently controls whether
legacy text appears in the current readable body; it never erases the embedded
legacy record or native comments. Both may be specified in update field files.
By default, legacy conversion or first omission preserves native history before
hiding retired text. Incoming legacy bytes absent from that history stay visible.
With `preserveHistory: false`, unpreserved legacy text stays visible; an explicit
`retainLegacyBody: false` deliberately hides it without requesting a history
comment. `retainLegacyBody: true` keeps it visible even when history is written.
Repeated unchanged updates reuse the body and existing exact authored history;
failed history readback or concurrent content drift refuses the rewrite.

`src/currentTrackingScenario.test.ts` composes these operations through one real SDK client/server session outside Git. Only external GitHub/auth ports are synthetic; settings, discovery, schemas, dispatch and owners run normally. Stored issue fields, parent membership, exact escaped history whitespace, comments, closure and configured Project Done are checked after writes. Invalid schemas and unsupported batch/defer requests must leave stored state and native write counts unchanged. Batch operations, trigger-based deferral and WIP enforcement remain unshipped; parking a draft is a separate operation. This synthetic replay does not complete the broader tracking parent or prove a live backlog replay.

## Blocker overrides and delivery health

`create`, `start` and `update` accept `--blocks <issue-numbers>` to add the
selected issue as a native blocker of named dependents. This preserves those
dependents' other blockers. `--blocked-by` retains its exact-set replacement
semantics. The corresponding MCP inputs are `blocks` and `blockedBy`.

A genuinely new blocker on configured-Project **In Progress** work requires
`--override-reason <reason>` / `overrideReason` (1–2,000 trimmed characters).
The configured author must authenticate, and an author-verified comment must
precede the native edge. Existing edges and removals require no override.
Unresolved dependent status refuses additions. Creation preflights existing
dependents before creating the new issue. A retry reuses the same verified
comment for the same native removal episode; a later remove/re-add records a
new episode. Comments record intent, not successful dependency writes.

GitHub does not atomically lock status, comments and relationships. Every actual
addition is rechecked at its write boundary. A later failure can follow earlier
writes; inspect native state and resume the known issue rather than recreate it.
If creation partially succeeds, the existing known-created recovery identifies
that issue. Low-level exported relationship primitives remain available to
callers that own their own policy; the guard applies to canonical issue writes.

```sh
ai-delivery --repo example/widget update --issue 17 --blocked-by 18 --override-reason 'Await prerequisite validation'
ai-delivery --repo example/widget health --from 2026-10-01T00:00:00Z --to 2026-10-08T00:00:00Z
```

`delivery_health` / `health` requires an explicit repository and UTC `[from,to)`
window. It reports distinct issues opened and closed, current open In Progress
work in that repository lane of the configured Project, oldest active issues by
creation time, and distinct native blocker additions classified by proven
historical Project membership and status. Reopen/reclose counts one closed issue
per window. Unknown history is separate and never a violation verdict. Age is
since issue creation, not time spent in progress.

The window must end at or before collection time. The read-only snapshot is non-atomic and records collection timestamps. Defaults
are 200 issues, five timeline pages per issue, five Project item pages per
status read and ten oldest issues; bounds are 500 issues, 20 pages per read
and 20 oldest issues. `--max-project-pages` bounds Project status collection. Limits and read failures
produce explicit partial **observed** counts, not complete zeroes. Issues whose
current Project status cannot be resolved have a separate unknown count.

## Typed issue journals

`issue_comment` posts a typed journal through the configured author role. The public
`commentIssue(context, input)` API uses the same implementation. The returned
`commentId`, `url`, `body` and `reused` come from a fresh GitHub comment readback;
the author, issue target and body must agree. Historical rewrites and reasoned
issue closure call this same writer through `issue_update`.

The public agent API also accepts `commentIssue(context, {issueNumber, body})`
for exact raw comments, such as an already-rendered history snapshot. It preserves
leading/trailing whitespace, line endings and content beyond the journal template
limits, and appends no wrapper or marker. Exact authored-body retries reuse the
existing comment and still require fresh readback. Blank bodies and complete
payloads exceeding `ISSUE_COMMENT_BODY_LIMIT` (65,536 UTF-16 code units, matching
[GitHub's first-party JavaScript validation](https://github.com/github/gh-aw/blob/3ead8042c7b1edc2128ba1b28b1b80d00b7f4c22/actions/setup/js/comment_limit_helpers.cjs))
fail before authentication or mutation. This supported client bound also applies
after typed-journal rendering; it does not truncate content. The MCP
`issue_comment` input remains the typed journal contract below. History rendering
and ordering of later issue rewrites belong to the caller.

Every kind requires `issueNumber`, a one-line `summary`, `status`, `keyNumbers`
(an array, empty when no numbers are known), `evidence` (HTTPS links), `nextStep`
and `nextDate` (`YYYY-MM-DD`, or `null` when unscheduled). The summary is the first
visible line, numbers stay inline, and evidence should be reachable outside the
operator's machine. Validation requires HTTPS with a DNS hostname; it rejects
file paths, credential-bearing URLs, IP literals, localhost and `.local` names.
It does not probe remote reachability. Each kind also requires these fields:

| Kind       | Required fields                                                                           |
| ---------- | ----------------------------------------------------------------------------------------- |
| `start`    | `outcome`                                                                                 |
| `progress` | `done` (nonempty list), `decisionNeeded`; at least one evidence link                      |
| `decision` | `decision`, `rationale`                                                                   |
| `blocker`  | `blocker`, `resolution`                                                                   |
| `closeout` | `acceptance` (nonempty `{criterion, evidence}` list), `followUps` (list; empty when none) |

Optional `details` adds supporting prose. `lengthCap` (600–10,000 characters,
default 1,800) limits the expanded journal: excess fields move into one collapsed
details section, without truncating acceptance evidence. Keep bulky inventories
in linked evidence instead of the summary.

```json
{
  "issueNumber": 17,
  "kind": "progress",
  "summary": "Input validation is implemented and ready for review.",
  "status": "In progress",
  "done": ["Added malformed-input handling and regression coverage"],
  "keyNumbers": ["7 focused tests passed"],
  "decisionNeeded": "None",
  "evidence": ["https://github.com/example/widget/pull/23"],
  "nextStep": "Complete independent review",
  "nextDate": "2026-10-09"
}
```

Successful tracked `issue_start` and `issue_develop` calls publish one start
journal. Scratch work, failed readiness and failed development do not claim a
start. `issue_finish` publishes closeout only after its existing merge, closure,
Project and cleanup contracts succeed, with each checkbox acceptance criterion
linked to the merged PR and a follow-up field. The PR carries the verification
and review evidence; the comment does not create another acceptance gate.

Exact manual retries reuse the same authored comment. Automatic retries find the
original start or exact-merge closeout even after a lost response or worktree
cleanup. Markers from another author never establish reuse. Operations from the
same local controller serialize their comment writes; independently configured
controllers still require one issue owner. A failed journal write/readback is
reported and the same lifecycle call can recover it. Created-issue failures
return the exact issue identity and `safeResume.arguments`. Incomplete tracking
uses `resumeCreated: true`; later start recovery preserves the current native
body and eligibility without replaying the original tracking fields. Historical comments are
preserved. Generated issue Status blocks and general readability warnings are
owned by the separate issue-contract work.

## Contributor checks and release

Use Node 24.21.0 and npm 11.19.0. `npm ci` installs the single committed lockfile; `npm run checks` is the canonical local gate and runs Oxfmt, native Oxlint with `oxlint-tsgolint`, strict TypeScript, a compiled build, and Vitest over the emitted `dist/**/*.test.js` files. The compiled test target preserves CLI child-process and package-file assertions. `npm run build` can be run separately before packing. Tests cover discovery, identity, admission drift, lifecycle receipts, interruption/recovery, cleanup, and plugin boundaries with synthetic repositories. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local commands and release prerequisites.

The standalone lint config enables native error, promise, unsafe-value, and explicit-type checks. TypeScript uses exact optional properties, checked indexed access, explicit overrides, return/fallthrough, and unused-symbol checks. Tests and review cover the delivery behavior boundary.

Installing the package does not switch an existing consumer. Run `npm run checks`, `npm run build`, and `npm pack --dry-run` before release.
