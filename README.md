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
      "credentialEnv": { "token": "DELIVERY_AUTHOR_TOKEN" }
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

An App author uses the same `credentialEnv` shape as the reviewer. Roles and credential environment names must be distinct. Credential values and private keys remain outside source control. A configured personal author uses only its named token variable. The optional `--identity` or `AI_DELIVERY_IDENTITY` override must select the command's configured role; neither is needed for normal operation. The explicit legacy `--identity personal --personal-auth` override is limited to development access diagnosis under an App author configuration; publication requires the configured author.

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

`start` creates or reuses a GitHub-linked branch from the repository's default branch. It can create a tracking issue first, or resume a known partially created issue with `--resume-created`; recovery returns the exact known issue and safe arguments without creating another issue. Hosts own local worktree preparation and cleanup. PR creation accepts any non-empty body, appends the issue closing reference when absent, and reuses the matching remote branch/PR. Merged completion uses GitHub issue association even after branch deletion. Existing repository labels are accepted; an unknown label is refused before issue mutation.

For a new issue, `start --request-id <stable-id>` records inert retry markers in its body. Retry the same request after an unknown response; matching remote state is recovered, while conflicting intent or duplicate matches refuse. Without an explicit ID, identical tracking inputs share a deterministic retry identity. Supply a new ID for a separate issue with identical inputs. A retry search beyond 2,000 issues refuses and asks for the known issue number. `pr:create --head <branch>` selects an existing linked branch when an issue has several.

Formal review requires a validated independent artifact and the configured reviewer App. The artifact binds author/reviewer identities, exact commit/tree and complete changed-path digest. The review body retains the full artifact and its digest so merge can verify the original binding even if GitHub remaps a review's commit ID after a rebase. A matching remote review is reused; conflicting actor, head, state or duplicate artifact markers refuse. Submission reads back the exact review ID and artifact. Reviews containing only a historical marker require a fresh review. Its new `ai-delivery.github-review@1` receipt is separate from historical local-evidence receipts. CLI `--artifact` reads a UTF-8 JSON file; MCP takes its JSON content.

An App approval does not prove that GitHub counted it. `pr:checks` exposes the live required-review decision. Merge requires one independent exact-head App review, its current readback, satisfied GitHub review requirements, no unresolved native blockers, and fresh CLEAN eligibility at the reviewed head and current base. BLOCKED, BEHIND, DIRTY, UNSTABLE, unknown state or moved head/base refuses. The server merge mutation includes the reviewed SHA. Finish confirms the intended PR merged before closing its issue, and retries from remote readback without local receipts.

The removed `develop`, `verify`, `pr:checkout`, worktree creation/cleanup and local velocity record commands are no longer public CLI/MCP workflows. Preserve existing consumer checks, controller admissions and historical custody records. Their original schemas, digest identities, writer locks and operational closure rules remain separate. The legacy transition commands remain exposed, but this runtime cannot reproduce their historical repository-policy configuration binding: CLI/MCP inspection and apply refuse without executing policy or converting records. Complete those transitions with the original controller. Explicit runtime stage/admit remain supported.

## Standalone plugin and explicit runtime setup

Manage the native plugin with an explicit package version:

```sh
ai-delivery plugin install --host codex --scope user --version <published-version> --json
ai-delivery plugin doctor --host codex --scope user --json
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
Doctor reports managed installation and source integrity, skills, and a direct
credential-free stdio startup check of the selected bundled MCP server. Startup
means that the server initialized and listed its tools; it does not validate
user settings, receive GitHub credentials, or authenticate either delivery role.
For an opt-in authentication check, select a repository explicitly:

```sh
ai-delivery --repo example/widget plugin doctor --host codex --scope user --check-auth --json
```

This checks settings and named process references before running the verified,
enabled plugin's selected CLI `config:resolve`. It reports authenticated actors,
repository access and visible review rules separately. Only configured credential
names and required runtime selectors reach that subprocess; unrelated tokens and
legacy personal overrides do not. Missing or invalid inputs stop before key
access or network authentication. Dry-run performs none of these checks.
The readback is labelled `selected_runtime_cli`; it does not prove GUI credential
propagation or counted exact-head approval. `config:resolve` remains available
for direct CLI readback; check an actual native tool call separately. The
[credential and readiness guide](plugins/ai-delivery/README.md#credentials-and-readiness)
explains the environment boundary and the evidence to retain without secrets.
Restart the native host
after changing a plugin so it reloads that selection. Installing a plugin does not admit a consumer controller. Ordinary remote GitHub delivery uses user configuration; explicit controller staging and admission remain separate operations.

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
reported and the same lifecycle call can recover it. Creation-only start failures
return the created issue identity and `safeResume.arguments` with
`resumeCreated: true` and `develop: false`, so recovery never creates another
issue or starts development. Historical comments are
preserved. Generated issue Status blocks and general readability warnings are
owned by the separate issue-contract work.

## Contributor checks and release

Use Node 24.21.0 and npm 11.19.0. `npm ci` installs the single committed lockfile; `npm run checks` is the canonical local gate and runs Oxfmt, native Oxlint with `oxlint-tsgolint`, strict TypeScript, a compiled build, and Vitest over the emitted `dist/**/*.test.js` files. The compiled test target preserves CLI child-process and package-file assertions. `npm run build` can be run separately before packing. Tests cover discovery, identity, admission drift, lifecycle receipts, interruption/recovery, cleanup, and plugin boundaries with synthetic repositories. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local commands and release prerequisites.

The standalone lint config enables native error, promise, unsafe-value, and explicit-type checks. TypeScript uses exact optional properties, checked indexed access, explicit overrides, return/fallthrough, and unused-symbol checks. Tests and review cover the delivery behavior boundary.

Installing the package does not switch an existing consumer. Run `npm run checks`, `npm run build`, and `npm pack --dry-run` before release.
