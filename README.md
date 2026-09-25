# ai-delivery

Generic GitHub issue and pull request delivery for repositories that opt in with a source-controlled `ai-delivery.config.json` and a `RepositoryDeliveryPolicy@1` module. The package provides one `ai-delivery` CLI, one stdio MCP server, and thin plugin assets in `plugins/ai-delivery`.

The package contains no repository-specific policy, credential, model, or deployment configuration. A consuming repository owns its issue taxonomy, native Project fields, author and reviewer GitHub App credentials, delivery stages, and phase constraints. The runtime refuses a missing or untracked configuration or policy module.

## Availability and installation

Install the versioned package from npm or a reviewed package archive. The
consuming repository must run its own configuration and runtime-admission
procedure before any lifecycle write.

```sh
node --version # 24.21.0
npm --version  # 11.19.0
npm install --save-dev @aviaratech/ai-delivery@0.1.0
npx ai-delivery --help
npx ai-delivery --repo-root /absolute/path/to/consumer --identity configured-author info --issue 17
npx ai-delivery --repo-root /absolute/path/to/consumer --identity configured-author mcp:serve
```

`info` is a read. `verify`, PR publication, formal review submission and finish
are lifecycle writes. The CLI and MCP server enforce the same admission and
identity rules. The [plugin guide](plugins/ai-delivery/README.md) covers host
installation.

## Configure a consuming repository

Commit `ai-delivery.config.json` at that repository's Git root. It selects the
repository, its native issue types, Project number, exact Points/Priority field
IDs and choices, four Project status names, command checks and timeouts, a
`RepositoryDeliveryPolicy@1` module, and distinct author and reviewer App role
names. Field IDs and choices must match the consuming repository's live GitHub
metadata. The parser and policy contract are exported from
`@aviaratech/ai-delivery`; `src/config/deliveryConfig.test.ts` and
`src/delivery/delivery.test.ts` contain fully synthetic examples for unrelated
repositories. Copy their shape, then substitute your own repository's native
metadata and policy. There is no built-in organization policy or stage list.

The policy module must implement `classifyExactRange` and `validateBoundary`.
It defines the repository's ordered verification stages, risk and any additional
publication or merge constraints. Its source is tracked alongside the config;
source/config/policy drift invalidates prior receipts. Run the consumer's policy
checks before making lifecycle writes. A missing or untracked module is refused.

Set each role's three configured **environment variable names** to the App ID,
installation ID and private-key file path on the host. Keep secret values and
key files out of Git and out of CLI arguments. The author App installation
requires Contents, Issues, organization Projects and Pull requests **write**
permissions. The reviewer App installation requires Contents **read** and Pull
requests **write** permissions. A consuming policy may require additional
permissions. The roles must resolve to distinct actors. Personal token use is
an explicit `--personal-auth` author-only mode;
it is never a fallback. Use a deliberately synthetic test repository for the
first end-to-end rehearsal; examples here must not be run against a live issue.

Before any CLI or MCP lifecycle write, the consuming installer must place a private `ai-delivery.runtime-admission@1` record at `<git-common-dir>/ai-delivery/runtime-admission.json`. It binds the verified source archive, repository config digest, package version, capability 1, and actual CLI, MCP launcher, and plugin manifest byte hashes and real paths. Both invocation surfaces validate the same record before writes; a missing, stale, or mismatched record refuses the operation. Installation does not create this record automatically. Reinstall or reissue the record after package, config, or launcher changes. Existing rows in the canonical `.issue-cli/worktrees.json` registry remain with their original runtime unless they have an exact immutable `ai-delivery.worktree-owner@1` witness. Do not convert old receipts into new approvals or run old and new writers for the same active issue.

`verify` classifies a clean Git base/head range, runs only the stages selected by the repository policy, and persists content-addressed private checkpoints under the Git common directory. It reuses compatible complete stages and rejects corrupt or stale inputs. The `--admit` flag explicitly admits additional resource classes. Publication creates a draft PR only after exact-head verification; a high-risk policy also requires a prepublication review artifact. Ready promotion and merge require a submitted formal review. Merge checks live blockers, checks, base/head coordinates, and the policy boundary. Repositories may require an exact base/head lease for merge.

For recovery, inspect the original issue/PR, worktree registry and exact source
head before retrying. A `created-not-started` response includes `safeResume`
arguments; use those arguments unchanged to resume the known issue. `verify`
reuses compatible stage checkpoints after interruption. If code, config, policy,
the selected stage inputs or a checkpoint changes, regenerate the affected
proof. A stopped or failed publish/finish must be read back before retrying;
never infer completion from a timed-out command. Task assignment and model
routing belong to a separate orchestrator, not this CLI.

## Compatibility contract

The MCP input and result contract is `ai-delivery.mcp@1`, exported as `AI_DELIVERY_MCP_CONTRACT_VERSION`. It retains the 13 `issue_*` tool names. Each tool rejects unknown fields at the request boundary. `issue_create` accepts a title with optional body, Issue Type, Points, Priority, taxonomy labels, milestone, parent and blockers; it returns `{body, created: {number, title, url}}`. A linked parent is read back and cleared of Points. `issue_start({issueNumber})` always checks readiness and prepares that existing issue; `develop` gates only preparation of a newly created issue. New starts default to 2 Points. `resumeCreated` requires both `issueNumber` and `develop: true` and never creates a second issue. Immediate creation and development preflights readiness before creation and returns `ai-delivery.issue-start-registration@1` with `status: "started"` or a `created-not-started` failure and exact `safeResume` arguments. The CLI prints that recovery JSON and exits nonzero for `created-not-started`. Scratch starts derive safe names from the request or title and return the branch and worktree path. `repo` on create, start and ready check, or global CLI `--repo`, must match the repository selected by the checkout's validated config; a mismatch fails before a GitHub call.

`issue_update` returns authoritative issue readback; `issue_info` returns current native metadata, parent, blockers, Project state and registered worktree; `issue_ready_check` returns deterministic admission and reasons; `issue_develop` and `issue_worktree_create` return registered worktree rows. `issue_verify` returns classification, aggregate, manifest and publication evidence IDs. `issue_pr_create` returns the PR number, URL and bound publication evidence ID; `issue_pr_info` returns number, state, exact head/base, draft flag and URL. `issue_pr_review` returns an exact-head submitted review receipt, `issue_pr_merge` a durable merge receipt, and `issue_finish` returns the merge SHA and successful issue/cleanup readback. CLI and MCP call the same owners for these tools.

The CLI also exposes native relationship reads (`parent`, `subissues`, `blockers`), registry reads and clean registered PR/standalone cleanup (`worktrees:list`, `worktrees:status`, `worktrees:cleanup`), and PR reads and exact-head App-authorized checkout (`pr:list`, `pr:checks`, `pr:checkout`). A cleaned PR worktree can be reopened when its retained branch still matches the remote head. `migrate:legacy-issues --input-file` produces an offline `ai-delivery.legacy-issue-migration@1` plan without live writes. `metrics velocity --json` reads completed local delivery records and returns `ai-delivery.velocity-report@1` with buckets for configured Points; unknown blocker and review measurements remain null. `finish` can confirm completion after a lost response by matching the exact merge receipts, delivery record and live issue/Project state. Installing the package never migrates active runtime state automatically.

## Contributor checks and release

Use Node 24.21.0 and npm 11.19.0. `npm ci` installs the single committed lockfile; `npm run checks` is the canonical local gate and runs Oxfmt, native Oxlint with `oxlint-tsgolint`, strict TypeScript, a compiled build, and Vitest over the emitted `dist/**/*.test.js` files. The compiled test target preserves CLI child-process and package-file assertions. `npm run build` can be run separately before packing. Tests retain the accepted 25 synthetic lifecycle, identity, receipt, recovery, cleanup, and plugin cases. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local commands and release prerequisites.

The standalone lint config enables native error, promise, unsafe-value, and explicit-type checks. TypeScript uses exact optional properties, checked indexed access, explicit overrides, return/fallthrough, and unused-symbol checks. Tests and review cover the delivery behavior boundary.

Installing the package does not switch an existing consumer. Run `npm run checks`, `npm run build`, and `npm pack --dry-run` before release.
