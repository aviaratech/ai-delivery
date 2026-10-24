# ai-delivery

## Scope charter

ai-delivery manages **GitHub issues, pull requests, independent reviews, guarded merges and the merge queue** through a CLI, stdio MCP server and Codex/Claude Code plugin. Issues carry the work contract; GitHub supplies relationships, Project tracking, checks and review eligibility. Hosts prepare worktrees, run contributor checks, commit and push.

The runtime reads operator-owned JSON and GitHub metadata. It does not execute a consuming repository's policy or checks. Explicit `repo: "owner/name"` calls work outside Git and can select different repositories in one MCP session. The supported GitHub host is `github.com`.

This docs-first change retains the existing controller, transition and migration modules. Their support commands appear below; removal and source-size reduction remain later work in [#201](https://github.com/aviaratech/ai-delivery/issues/201).

## Command and tool map

Every executable CLI route and MCP tool maps to a charter item below. A dash means that surface has no corresponding entrypoint. Parent command groups and automatic help/version flags are not executable routes.

| Charter item | CLI route | MCP tool | Purpose |
| --- | --- | --- | --- |
| Issues | `create` | `issue_create` | Create a typed, sized issue |
| Issues | `start` | `issue_start` | Start a linked issue or register an unchanged investigation |
| Issues | `list`, `search` | `issue_list`, `issue_search` | Find work with native filters |
| Issues | `info`, `ready:check` | `issue_info`, `issue_ready_check` | Read state and deterministic readiness |
| Issues | `update` | `issue_update` | Update contracts, relationships, dates, status or deferral |
| Issues | `batch:update` | `issue_batch_update` | Plan/apply bounded native updates |
| Issues | `parent`, `blockers`, `subissues` | — | Inspect native relationships |
| Issues | — | `issue_comment` | Post a typed journal with readback |
| Issues | `board`, `health` | `delivery_board`, `delivery_health` | Read attention, readiness and delivery health |
| Issues | `board:reconcile` | `board_reconcile` | Reconcile scoped Project membership/status |
| Pull requests | `pr:create`, `pr:info` | `issue_pr_create`, `issue_pr_info` | Publish/reuse a linked PR and read its state |
| Pull requests | `pr:list`, `pr:checks` | — | List PRs and read required checks |
| Reviews | `pr:review` | `issue_pr_review` | Submit an independently produced review artifact |
| Reviews | `review submit`, `review doctor` | — | Submit a strict verdict or check an explicit App profile |
| Merges | `pr:merge`, `finish` | `issue_pr_merge`, `issue_finish` | Guard a merge; finish a complete issue/investigation |
| Merge queue | `merge queue add` | `issue_pr_merge` | Enqueue a PR using `queue: true` |
| Merge queue | `merge queue status`, `merge queue run` | `issue_pr_merge_queue_status`, `issue_pr_merge_queue_run` | Inspect/drain the host-local canonical queue |
| Issues/PRs: installation support | `plugin install`, `plugin doctor`, `plugin preview`, `plugin update`, `plugin rollback`, `plugin remove` | — | Manage the complete native plugin |
| Issues/PRs: controller support | `runtime:stage`, `runtime:admit` | `runtime_stage`, `runtime_admit` | Explicitly stage/admit a reviewed local runtime |
| Issues: retained compatibility | `worktree:transition:inspect`, `worktree:transition:apply` | `issue_worktree_transition_inspect`, `issue_worktree_transition_apply` | Historical custody transitions; current public entrypoints refuse unsupported policy bindings |
| Issues: migration support | `migrate:legacy-issues` | — | Plan an offline legacy issue migration |
| All charter items: setup | `config:resolve`, `mcp:serve` | — | Read the effective route or serve MCP |

Use `<route> --help` for current flags. The [plugin reference](plugins/ai-delivery/README.md) owns detailed configuration, contracts, authorization and recovery rules.

## Install and configure

Use Node **24.21.0** and npm **11.19.0** for the CLI/MCP controller and contributor checks. Public library consumers also support Node **26.2.0**. Install a qualified published package or reviewed archive, then follow [native installation](plugins/ai-delivery/README.md#native-installation). CLI, SDK and MCP entrypoints remain available.

Settings live at `~/.config/aviaratech-ai/ai-delivery.json`, or an absolute `AI_DELIVERY_CONFIG` path. A consuming repository needs no ai-delivery configuration files. A minimal illustrative configuration is:

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
      "authSource": "app",
      "appId": 12345,
      "installationId": 67890,
      "actorLogin": "your-reviewer-app[bot]",
      "provider": "openai"
    }
  },
  "project": 7,
  "checkoutRoots": ["/absolute/path/to/checkouts"]
}
```

Keep credential values outside source control. A personal author naming `GH_TOKEN` may use the selected existing active `gh` session when that variable is absent. An explicit empty/invalid token refuses; unrelated credentials never replace it. The reviewer uses its separate configured App source. Read [credentials and readiness](plugins/ai-delivery/README.md#credentials-and-readiness) before configuring either role.

```sh
ai-delivery --repo example/widget config:resolve
ai-delivery --repo example/widget info --issue 17
ai-delivery mcp:serve
```

A read-only request stays read-only. Discover the requested installed provider, inspect its schema and pass the named repository. Missing provider compatibility is reported; changing registrations, credentials or providers is a separate action.

## Ordinary delivery

Create/update a typed issue with a problem, outcome, observable acceptance and proof, non-goals, native Issue Type and Points. Readiness must pass and blockers must be resolved before starting. See [issue contracts](plugins/ai-delivery/README.md#issue-contracts) for history preservation, dates, batches, deferrals and Project reconciliation.

```sh
ai-delivery --repo example/widget ready:check --issue 17
ai-delivery --repo example/widget start --issue 17
# The host prepares a worktree, implements, checks, commits and pushes.
ai-delivery --repo example/widget pr:create --issue 17 --body-file ./pr-body.md --dry-run
ai-delivery --repo example/widget pr:create --issue 17 --body-file ./pr-body.md
```

Keep original operator authority, configured access, technical admission, independent review, counted approval and execution receipts separate. A relay, role flag, START or successful dry run grants no additional authority. An explicit hold or host refusal stops dependent writes; reconcile it through the authorized route. Read [authority and recovery](plugins/ai-delivery/README.md#authority-and-recovery) before delegated mutations.

Obtain independent review of the exact remote commit/tree/diff through the configured distinct reviewer App. The verdict records requested/effective model metadata honestly. [Review submission](plugins/ai-delivery/README.md#independent-review) explains strict verdict files, existing artifacts and profile compatibility. Submission must read back and count under GitHub's current rules.

```sh
ai-delivery --repo example/widget pr:create --issue 17 --ready
ai-delivery --repo example/widget pr:checks --pr 23
ai-delivery --repo example/widget finish --issue 17 --pr 23 --reviewed-head <reviewed-sha>
```

Required checks must be green for the exact reviewed candidate and current base. Stale/dismissed approval, conflicts, missing evidence or changed heads require reconciliation. GitHub supplies native eligibility; merge uses the independently reviewed SHA. Hosts own local cleanup.

For a **partial delivery**, use the separately authorized [nonclosing PR procedure](plugins/ai-delivery/README.md#nonclosing-pull-requests). An explicit `References #N` body and `nonClosing: true` alone do not authorize native closing-reference removal. `finish` refuses nonclosing mode; guarded `pr:merge` retains the issue open. Keep outstanding acceptance visible.

The [merge queue](plugins/ai-delivery/README.md#merge-queue) serializes canonical-repository integration with fresh native checks. Queue presence is not approval or a release.

## Output, journals and development

Issue/PR tools return compact JSON by default. `verbose: true` or CLI `--json --verbose` restores full payloads; recovery fields and warnings remain meaningful in either view. An incomplete or uncertain write requires native readback before retry. An output projection is not a custody or publication receipt.

[Typed journals](plugins/ai-delivery/README.md#typed-journals) lead with status and the next step, followed by the full summary and canonical evidence fields. Ten representative CLI input refusals have a failure sentence and a `Fix:` line; this bounded improvement does not claim measured error frequency or complete error coverage.

Public library exports are `.`, `./agent`, `./delivery` and `./mcp`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the pinned toolchain, focused local checks, required CI, confidentiality review and separately authorized release qualification/publication. Fast/focused success does not qualify a release archive or prove host adoption.
