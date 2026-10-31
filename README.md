# ai-delivery

ai-delivery handles **GitHub issues, pull requests and independent reviews** through a CLI, stdio MCP server and Codex/Claude Code plugin. GitHub owns relationships, Project tracking, checks and review eligibility. Hosts prepare worktrees, run checks, commit, push and clean up.

Explicit `--repo owner/name` or MCP `repo: "owner/name"` works outside Git. Without it, the checkout's `origin` selects the repository. Only `github.com` is supported. The runtime reads operator-owned JSON; it never executes a consuming repository's policy or checks.

## Installation and runtime

Use Node **24.21.0** and npm **11.19.0** for CLI/MCP and contributor checks; public library consumers also support Node **26.2.0**. Install a qualified published version or reviewed archive. The [complete plugin](plugins/ai-delivery/README.md) is the canonical native installation; CLI/SDK/MCP entrypoints remain available.

```sh
npm install --global @aviaratech/ai-delivery@<qualified-version>
ai-delivery plugin install --host codex --scope user --version <qualified-version> --json
ai-delivery plugin doctor --host codex --scope user --json
ai-delivery --repo example/widget info --issue 17
ai-delivery mcp:serve
```

Use `--host claude-code` for Claude Code, which supports `user`, `project` and `local` scopes; Codex supports `user`. Select a project with `--repo-root`. Preserve managed state on recovery errors; never substitute another version silently.

## User configuration

Use `~/.config/aviaratech-ai/ai-delivery.json`, or an absolute `AI_DELIVERY_CONFIG` path. A consuming repository needs no ai-delivery files. Illustrative settings:

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
  "checkoutRoots": ["/absolute/path/to/clones"]
}
```

Keep credentials outside source control. An absent conventional `GH_TOKEN` selects the existing active `gh` personal session; an empty/invalid value fails without switching accounts. Custom token references require their exact value. The reviewer uses its distinct configured App, with no personal fallback. Read [credentials and readiness](plugins/ai-delivery/README.md#credentials-and-readiness), including GUI environment limits, legacy App references and selected key sources.

The illustrated reviewer profile reads unencrypted RSA PEM from `GH_PRIVATE_KEY_DELIVERY_REVIEWER` when `credentialSource` is omitted. Supply it through your existing secret mechanism. Optional env/file/command sources follow the [configuration schema](src/config/deliveryConfig.ts); a failed source never selects another.

## Five-minute reviewer setup

Configure a distinct installed App with `contents:read` and `pull_requests:write`, its actual identity/provider, and one supported credential source. Authentication does not prove counted approval. Follow the [independent reviewer command](plugins/ai-delivery/README.md#independent-reviewer-command) and [review schemas](src/review.ts). Strict `review submit` requires requested/effective model metadata and provider compatibility; never fabricate unexposed metadata. Established integrations retain the `pr:review --artifact` route.

## GitHub-gated lifecycle

Create/update a typed issue with problem, outcome, acceptance/proof, non-goals, native Issue Type and Points. Preserve history when rewriting. Ready, open, unblocked issues can start; readiness alone does not activate work.

```sh
ai-delivery --repo example/widget ready:check --issue 17
ai-delivery --repo example/widget start --issue 17
# Host: prepare worktree, implement, check, commit and push.
ai-delivery --repo example/widget pr:create --issue 17 --body-file pr-body.md
# Independent reviewer submits its own exact-head verdict/artifact.
ai-delivery --repo example/widget pr:create --issue 17 --ready
ai-delivery --repo example/widget pr:checks --pr 23
ai-delivery --repo example/widget finish --issue 17 --pr 23 --reviewed-head <sha>
```

GitHub's current required checks, counted reviews, blockers and merge eligibility govern the exact head/current base. The builder never approves its own work. Read back uncertain writes before retrying; a dry run grants no authority. Respect explicit provider/read-only requests and actual host refusals.

After verified `finish`, cleanup removes only the exact clean registered worktree and local branch with retained-source proof. Run outside that worktree; unregistered or unsafe source stays in place with a reason.

For partial delivery, `--non-closing` requires a canonical `References owner/repo#number` body and complete native evidence; a new linked-branch draft requires a separately authorized exact reference action. `finish` refuses nonclosing delivery. A complete executable child can close normally while its parent stays open.

## Command and tool map

These are all executable routes; groups/help flags are omitted. A dash means no matching surface. Use each route's `--help` and the published MCP schema for inputs.

| Charter/job | CLI | MCP |
| --- | --- | --- |
| Issues: create/start | `create`, `start` | `issue_create`, `issue_start` |
| Issues: find/read | `list`, `search`, `info`, `ready:check` | `issue_list`, `issue_search`, `issue_info`, `issue_ready_check` |
| Issues: edit/batch | `update`, `batch:update` | `issue_update`, `issue_batch_update` |
| Issues: relationships | `parent`, `blockers`, `subissues` | — |
| Issues: journals | — | `issue_comment` |
| Issues: attention/health | `board`, `health` | `delivery_board`, `delivery_health` |
| Issues: Project reconciliation | `board:reconcile` | `board_reconcile` |
| Pull requests | `pr:create`, `pr:info` | `issue_pr_create`, `issue_pr_info` |
| Pull requests: observations | `pr:list`, `pr:checks` | — |
| Reviews: artifact | `pr:review` | `issue_pr_review` |
| Reviews: profile/verdict | `review doctor`, `review submit` | — |
| Delivery support: plugin | `plugin install`, `plugin doctor`, `plugin preview`, `plugin update`, `plugin rollback`, `plugin remove` | — |
| Issues: offline migration plan | `migrate:legacy-issues` | — |
| All: setup/transport | `config:resolve`, `mcp:serve` | — |

The contract is `ai-delivery.mcp@2`; [tool schemas](src/mcp/tools.ts) and CLI `--help` supply complete inputs. Results retain warnings, history and recovery fields; MCP `verbose: true` or CLI `--json --verbose` requests full payloads. Journal `status` is prose, separate from Project Status.

## Upgrade a host

Choose an explicitly qualified version; the historical **0.3.35** example was checked on **2026-10-22**, not a promise of today's latest. Preserving updates qualify Claude Code **2.1.296** and Codex CLI **0.162.1** only. Claude downgrades remain unqualified; Codex rollback selects its recorded previous version.

Installed metadata, separate doctor startup and the active conversation's loaded MCP version are distinct. Record unexposed loaded versions as unverified. Follow the host's activation guidance and preserve active jobs before an operator-approved restart. Windows command credential sources and protected-file permission equivalence remain unqualified.

## Plugin installation

Legacy standalone MCP support lasts at least **two subsequent stable releases and 90 days** after a qualified migration first ships; that anchor remains unknown. Preview/doctor do not qualify migration or start that clock. Migration apply, registration retirement and settings rollback remain unavailable; see [#116](https://github.com/aviaratech/ai-delivery/issues/116). Public npm/local-catalog distribution does not establish plugin-directory admission.

## Contributor checks and release

[CONTRIBUTING.md](CONTRIBUTING.md) owns pinned tooling, focused local checks, full GitHub checks and release procedures. Ordinary PR checks exclude release installations/archive cases; fast/focused success never qualifies a package. Supply the actual Node26 consumer executable through `AI_DELIVERY_NODE26_EXECUTABLE` where required.

Release still requires the exact mandatory archive inventory, complete release/consumer/cleanup proof, confidentiality review and TruffleHog scanning. A dry inventory, fixture install, inert repack or wrapper is not current archive/native-adoption proof. Publication consumes the independently accepted source/version/digest and original successful artifact; verify actual registry bytes, integrity, cryptographic provenance and `latest` afterward. Never replace missing proof with a later rerun.

Release is manual, main-only and uses npm trusted publishing. A packaged README edit changes the release candidate: retain accepted archives and independently qualify the new exact source/archive before dispatching.

Source version **0.3.37** and green PR checks do not establish its qualification; see [#199](https://github.com/aviaratech/ai-delivery/issues/199). Wrappers and workflow definitions do not prove [#200](https://github.com/aviaratech/ai-delivery/issues/200)'s **under-60-second regular checks / under-five-minute qualification** targets. Functional removals and remaining documentation obligations stay with [#201](https://github.com/aviaratech/ai-delivery/issues/201).
