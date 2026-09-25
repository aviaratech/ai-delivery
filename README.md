# ai-delivery

Generic GitHub issue and pull request delivery with Git/GitHub discovery and a source-controlled `RepositoryDeliveryPolicy@1` module. Routing overrides are optional. The package provides one `ai-delivery` CLI, one stdio MCP server, and thin plugin assets in `plugins/ai-delivery`.

The package contains no repository-specific policy, credential, model, or deployment configuration. A consuming repository owns its issue taxonomy, native Project fields, author and reviewer GitHub App credentials, delivery stages, and phase constraints. The runtime refuses an untracked override file or a missing or untracked policy module. Credentials and delivery policy remain explicit.

## Availability and installation

Install the versioned package from npm or a reviewed package archive. The
consuming repository must run its own configuration and runtime-admission
procedure before any lifecycle write.

```sh
node --version # 24.21.0
npm --version  # 11.19.0
npm install --save-dev @aviaratech/ai-delivery@0.2.0
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

Set each role's environment variables to its App ID, installation ID and absolute
private-key path. Secret values and keys stay outside Git. The author App needs
Contents, Issues, organization Projects and Pull requests write permissions plus
read access to repository issue types and fields. Discovery uses that author
identity; review operations still use the distinct reviewer App (Contents read,
Pull requests write). Personal author authentication requires explicit
`--identity personal --personal-auth`; it is never an automatic fallback.

Inspect the result before issuing a new runtime admission:

```sh
npx ai-delivery --repo-root /absolute/path/to/consumer config:resolve
```

This read returns `routing` (repository, Project/field/option identities and
selection source) and `configDigest`. CLI and MCP use the same asynchronous
`loadDeliveryConfig` resolver. `issue_create` and `issue_info` also expose the
resolved routing. An MCP server stays bound to its startup checkout; use separate
bindings or explicit CLI checkout selection for multiple repositories.

The consumer installer must issue a private `ai-delivery.runtime-admission@2`
record at `<git-common-dir>/ai-delivery/runtime-admission.json`. It binds the
verified archive, package version, capability 2, actual CLI/MCP/plugin bytes and
paths, repository and the resolver's `configDigest`. That digest includes the
policy/settings source, optional overrides and effective discovered routing;
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

The MCP input and result contract is `ai-delivery.mcp@1`, exported as `AI_DELIVERY_MCP_CONTRACT_VERSION`. It retains the 13 `issue_*` tool names. Each tool rejects unknown fields at the request boundary. `issue_create` accepts a title with optional body, Issue Type, Points, Priority, taxonomy labels, milestone, parent and blockers; it returns `{body, created: {number, title, url}, routing}`. A linked parent is read back and cleared of Points. `issue_start({issueNumber})` always checks readiness and prepares that existing issue; `develop` gates only preparation of a newly created issue. New starts default to 2 Points. `resumeCreated` requires both `issueNumber` and `develop: true` and never creates a second issue. Immediate creation and development preflights readiness before creation and returns `ai-delivery.issue-start-registration@1` with `status: "started"` or a `created-not-started` failure and exact `safeResume` arguments. The CLI prints that recovery JSON and exits nonzero for `created-not-started`. Scratch starts derive safe names from the request or title and return the branch and worktree path. `repo` on create, start and ready check, or global CLI `--repo`, must match the repository selected by the checkout's validated Git remote; a mismatch fails before a GitHub call.

`issue_update` returns authoritative issue readback; `issue_info` returns current native metadata, parent, blockers, Project state and registered worktree; `issue_ready_check` returns deterministic admission and reasons; `issue_develop` and `issue_worktree_create` return registered worktree rows. `issue_verify` returns classification, aggregate, manifest and publication evidence IDs. `issue_pr_create` returns the PR number, URL and bound publication evidence ID; `issue_pr_info` returns number, state, exact head/base, draft flag and URL. `issue_pr_review` returns an exact-head submitted review receipt, `issue_pr_merge` a durable merge receipt, and `issue_finish` returns the merge SHA and successful issue/cleanup readback. CLI and MCP call the same owners for these tools.

The CLI also exposes native relationship reads (`parent`, `subissues`, `blockers`), registry reads and clean registered PR/standalone cleanup (`worktrees:list`, `worktrees:status`, `worktrees:cleanup`), and PR reads and exact-head App-authorized checkout (`pr:list`, `pr:checks`, `pr:checkout`). A cleaned PR worktree can be reopened when its retained branch still matches the remote head. `migrate:legacy-issues --input-file` produces an offline `ai-delivery.legacy-issue-migration@1` plan without live writes. `metrics velocity --json` reads completed local delivery records and returns `ai-delivery.velocity-report@1` with buckets for configured Points; unknown blocker and review measurements remain null. `finish` can confirm completion after a lost response by matching the exact merge receipts, delivery record and live issue/Project state. Installing the package never migrates active runtime state automatically.

## Contributor checks and release

Use Node 24.21.0 and npm 11.19.0. `npm ci` installs the single committed lockfile; `npm run checks` is the canonical local gate and runs Oxfmt, native Oxlint with `oxlint-tsgolint`, strict TypeScript, a compiled build, and Vitest over the emitted `dist/**/*.test.js` files. The compiled test target preserves CLI child-process and package-file assertions. `npm run build` can be run separately before packing. Tests cover discovery, identity, admission drift, lifecycle receipts, interruption/recovery, cleanup, and plugin boundaries with synthetic repositories. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local commands and release prerequisites.

The standalone lint config enables native error, promise, unsafe-value, and explicit-type checks. TypeScript uses exact optional properties, checked indexed access, explicit overrides, return/fallthrough, and unused-symbol checks. Tests and review cover the delivery behavior boundary.

Installing the package does not switch an existing consumer. Run `npm run checks`, `npm run build`, and `npm pack --dry-run` before release.
