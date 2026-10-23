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

Legacy App roles remain supported with `credentialEnv: { "appId": "APP_ID_VARIABLE", "installationId": "INSTALLATION_ID_VARIABLE", "privateKeyPath": "ABSOLUTE_PEM_PATH_VARIABLE" }`. Roles and credential environment names must be distinct. Credential values and private keys remain outside source control. A configured personal author uses its named token variable. With the conventional `GH_TOKEN` reference **absent**, it instead uses the existing active personal account from GitHub CLI `gh` for `github.com`. A present empty, malformed or expired token fails without switching accounts. A custom reference such as `DELIVERY_AUTHOR_TOKEN` always requires that exact value; its absence does not select a machine session. Unrelated `GITHUB_TOKEN` values do not satisfy either configured reference. The optional `--identity` or `AI_DELIVERY_IDENTITY` override must select the command's configured role; neither is needed for normal operation. The explicit legacy `--identity personal --personal-auth` override is limited to development access diagnosis under an App author configuration; it requires an explicit token and does not use a missing-token machine fallback. Publication requires the configured author.

The machine route uses `gh auth status --hostname github.com --active --json hosts`, validates the selected account's state, then privately obtains that exact user's credential through `gh auth token --hostname github.com --user <active-user>`. An actual authenticated user read must match the selection. Repository discovery and command execution retain that account; failed identity/access never selects another account. Inactive accounts with errors do not invalidate a healthy active user. Only required non-secret home/PATH/gh configuration selectors reach `gh`; token overrides, debug flags and unrelated credentials are excluded. No login, switch, refresh, credential-store scraping or persistent configuration change occurs. The reviewer still uses its distinct configured App, with no personal-session fallback.

`gh` must be executable on the running process's PATH and able to access its existing session. A terminal login does not prove that a Codex or Claude GUI process can find `gh` or use its keyring. `config:resolve` reports the selected route/executable and authenticated actor, or a safe actionable refusal. Default plugin doctor does not inspect or authenticate the session. This package currently supports `github.com` repositories; enterprise URLs or a conflicting `GH_HOST` refuse rather than silently using another host. No write probe or permission grant is performed, and a successful identity/repository read does not guarantee every later write or counted App approval.

The explicit organization Project number selects a compatible writable Project. Optional `pointsField`, `priorityField`, `statusField`, four `statuses` names (`todo`, `inProgress`, `blocked`, `done`), and `issueTypes` customize discovered metadata. Defaults are Points, Priority, Status and Todo/In Progress/Blocked/Done. IDs, option catalogs and issue types come from GitHub. This runtime supports github.com organization repositories and native organization single-select Points/Priority fields bound into the selected Project.

Every remote MCP tool accepts `repo: "owner/name"`; the CLI uses global `--repo`. Without a selector, the launch checkout's `origin` supplies the destination. Explicit remote calls never probe launch-directory Git or checkoutRoots. One MCP server can switch A → B → A without restart. Tool and server selectors that disagree are refused.

Local runtime setup and legacy transition calls select a matching `origin` per invocation. A matching current checkout wins; otherwise `checkoutRoots` may contain exact clone roots or parents whose immediate directories contain clones. Duplicate physical matches are collapsed. Zero or multiple matches refuse with a specific diagnostic; use `--repo-root` to select the intended matching clone. Git probes disable repository hooks, filters, fsmonitor and external diff/text conversion. Remote delivery never performs a checkout, push, or worktree mutation.

## Five-minute reviewer setup

1. Create or install a reviewer GitHub App distinct from the PR author. The runtime checks its installation permissions (`contents:read`, `pull_requests:write` at minimum), actual App ID and actor. Your repository may require additional approval eligibility; a successful authentication check does not establish a counted approval.
2. Fill the reviewer profile above with your nonsecret App ID, installation ID, exact `slug[bot]` actor and provider. Profile names are consumer-defined. Providers are `openai`, `anthropic`, `google` or `qwen`; submission checks both requested and effective model families against that declaration. These declarations do not attest the external agent's model by themselves.
3. Supply only that profile's selected credential source. With `credentialSource` omitted, the default is PEM in `GH_PRIVATE_KEY_DELIVERY_REVIEWER` for identity `delivery-reviewer`; other names replace punctuation with underscores and uppercase the identity. Set secrets through your existing environment/CI mechanism, outside source control. Explicit alternatives appear below.
4. Check the App from any directory, then have a fresh independent read-only reviewer reproduce verification and write its verdict:

```sh
ai-delivery review doctor --identity delivery-reviewer
ai-delivery review submit --pr 23 --head <reviewed-sha> --identity delivery-reviewer --verdict ./verdict.json --repo example/widget
```

`review doctor` mints the selected installation token and reads `GET /app`. It needs user settings but no checkout, issue or Project lookup, and posts no review. Submit uses the configured personal author for remote scope checks before reading the reviewer key; an App author requiring another key refuses this route. The existing lower-level artifact API remains available for established integrations.

For Claude Code, the optional narrow permission pattern is `Bash(ai-delivery review submit *)`. Add it only through your host's normal policy workflow. It does not replace independent review, grant operator authority or override a platform refusal. No dotenvx binary, versioned plugin-cache path or separate artifact-building command is needed.

A verdict is UTF-8 JSON, at most 64 KiB, with all of these fields. Replace the illustrative SHA/tree, issue and complete sorted paths with the exact independently reviewed state. Findings may be empty. Use `request-changes` for that verdict; it posts `REQUEST_CHANGES`, never approval. Add `"nonClosing": true` only for the existing explicit non-closing issue/PR contract.

```json
{
  "schemaVersion": "ai-delivery.review-verdict@1",
  "verdict": "approve",
  "summary": "Reviewed the complete change independently.",
  "issueNumber": 17,
  "scope": {
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "headTree": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "changedPaths": ["src/change.ts"]
  },
  "verificationReproduced": ["Reproduced the focused regression; integration not executed."],
  "requestedModel": "gpt-6-astra",
  "requestedEffort": "xhigh",
  "effectiveModel": "gpt-6-astra",
  "effectiveEffort": "xhigh",
  "elapsedMs": 120000,
  "findings": [],
  "readOnly": true
}
```

The visible review includes the exact raw verdict-file SHA256, requested/effective model and effort, elapsed time and findings, plus the existing hashed artifact. Unknown fields, missing metadata, provider mismatch and stale head/tree/scope refuse. The result includes the live required-review state; `still-required` is not a counted approval. A `submission-unverified` result preserves the artifact/head and any known review ID/URL: reconcile the original remote review before another submission. A matching acknowledged review is reused.

### Credential sources and additional profiles

Add `credentialSource` inside a reviewer profile. Sources are disjoint; a failure never selects another source. Keys remain in process memory, are validated as unencrypted RSA PEM, and are never printed or written by this runtime.

```json
{ "type": "env", "variable": "MY_REVIEWER_KEY", "encoding": "base64" }
```

```json
{ "type": "file", "path": "/absolute/operator-owned/reviewer.pem" }
```

The file source requires a regular file opened without following a symlink, current-user ownership where supported, one hard link and exactly mode 0600. It does not change permissions. Native Windows file-permission equivalence has not been qualified; use the env source there.

```json
{ "type": "command", "argv": ["/absolute/credential-helper", "reviewer-key"], "encoding": "pem", "env": ["HELPER_SESSION"] }
```

The command's first argv entry must be absolute; arguments are literal, with no `$USER`, tilde, pipeline or shell interpolation. `encoding` defaults to `pem`; `base64` requires canonical base64 of the PEM. The existing POSIX supervisor uses a fixed wait/exec shell handshake, bounds combined stdout/stderr to 64 KiB, cancels an unresponsive credential request after 30 seconds, and verifies owned process cleanup. This is a credential-request timeout, not a review or task runtime limit. Errors name only the identity/source and safe reason; an unverified cleanup requires reconciliation. Native Windows command sources currently refuse before spawn; Windows Credential Manager integration is deferred. Env remains supported on Windows.

Only a small OS selector set and explicitly listed helper `env` names reach the helper; the author token, other App keys and executable-injection selectors are excluded. Shared explicit helper-auth selectors are allowed. Commands are trusted operator configuration and are not a sandbox. Use an existing authenticated helper session and allow only its required selectors. The following are configuration examples, not credential provisioning or live qualification; replace executable paths, account names and references:

| Store | `argv` | Encoding / helper environment |
| --- | --- | --- |
| macOS login Keychain (Aviara's choice) | `["/usr/bin/security","find-generic-password","-a","your-user","-s","aviaratech.github-app.delivery-reviewer","-w"]` | `base64`; item value is base64 PEM |
| [1Password](https://www.1password.dev/cli/reference/commands/read) | `["/absolute/op","read","op://your-vault/your-item/private key"]` | `pem`; explicitly forward required existing session selectors such as `OP_SERVICE_ACCOUNT_TOKEN` |
| [AWS Secrets Manager](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/get-secret-value.html) | `["/absolute/aws","secretsmanager","get-secret-value","--secret-id","reviewer-key","--query","SecretString","--output","text","--no-cli-pager"]` | `pem`; e.g. explicit `AWS_PROFILE`/`AWS_REGION` for an existing session |
| Linux Secret Service | `["/usr/bin/secret-tool","lookup","service","delivery-reviewer"]` | `pem`; explicitly forward required desktop session selectors |
| [HashiCorp Vault](https://developer.hashicorp.com/vault/docs/commands/kv/get) | `["/absolute/vault","kv","get","-mount=secret","-field=private_key","delivery-reviewer"]` | `pem`; e.g. explicit `VAULT_ADDR`/`VAULT_TOKEN` |
| Windows Credential Manager | A consumer-owned helper would return the selected PEM or base64 on stdout. | Illustrative future integration; native command supervision is unavailable in this version. |

Optional top-level `reviewerProfiles` maps additional names to the same complete explicit profile shape. Each map key must equal its `identity`, distinct from the configured author. For example a `claude-reviewer` profile uses its own App/installation/actor, `provider: "anthropic"` and selected source. `--identity` selects exactly one profile; no other profile's source is read. Legacy `credentialEnv` profiles remain valid for existing callers but must be migrated to explicit metadata for these new commands.

## GitHub-gated lifecycle

```sh
ai-delivery --repo example/widget config:resolve
ai-delivery --repo example/widget ready:check --issue 17
ai-delivery --repo example/widget start --issue 17
# Prepare a host-owned worktree, implement, run repository checks, commit and push.
ai-delivery --repo example/widget pr:create --issue 17 --body-file ./pr-body.md --dry-run
ai-delivery --repo example/widget pr:create --issue 17 --body-file ./pr-body.md
# Obtain an independent review of the exact remote PR head and diff.
ai-delivery review submit --pr 23 --head <reviewed-sha> --identity delivery-reviewer --verdict ./verdict.json --repo example/widget
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

New linked-branch non-closing publication requires an explicitly authorized closing-reference action. Bare `--non-closing` refuses before creating a PR and grants no relationship-removal authority. After obtaining a grant for the canonical repository, OPEN issue, exact linked branch/head H, default base B, configured author and safe title/body, request the action on the existing publication owner:

```sh
ai-delivery --repo example/widget pr:create --issue 17 --head issue/17 --non-closing --reconcile-non-closing-reference --expected-head <H> --expected-base <B> --body-file ./partial-body.md --dry-run
# Execute the same command without --dry-run only within the exact grant.
```

The optional MCP input is `reconcileNonClosingReference: true` with `expectedHeadSha`, `expectedBaseSha`, `nonClosing: true` and an explicit safe `body`. The action creates at most one author-owned DRAFT per invocation. A complete already-safe graph needs no removal; otherwise complete all-closing and `userLinkedOnly` connections must each contain only the intended issue, with authorized exact closing cross-references. Only then can one `removeCloseIssueReferences` request remove that exact issue/PR pair. Foreign, mixed, automatic-only, duplicate, incomplete or changed evidence refuses. No branch unlink, body transition, promotion, review, merge or issue closure is part of this action. Final success requires unchanged identity/intent/source and the usual strict non-closing readback. Dry-run reports pending action and `nonClosingVerified: false`; it performs no mutation.

The trusted caller must retain the original human grant, reviewed source/intent and invocation/attempt receipts, and check them before every mutation. Flags, credentials, a unique PR match or a successful dry-run do not prove authority or historical request origin. Runtime limits are per invocation; it reads no caller receipt history and supplies no cross-invocation deduplication. For a caller-admitted continuation use the exact existing `--pr` with unchanged H/B/body, never an implicit match or replacement. A terminal before-action receipt can establish a proven non-attempt; an arbitrary crash cannot. An uncertain create acknowledgement allows only read-only candidate discovery, not another creation or implicit cleanup. After uncertain removal, an already-safe exact graph can be reused without mutation. A remaining/reappeared edge or missing history blocks another removal until authoritative non-execution proof plus admitted continuation, or fresh human authority naming the exact current pair and acknowledging the unresolved attempt.

Removal is non-transactional and has no expected-head CAS. A published draft with a closing edge may remain after failure; concurrent external state/head/body changes cannot all be prevented. Pre/post readback detects observed drift, reports whether removal was not attempted, acknowledged or uncertain, and never retries or rolls back automatically. Preserve the original receipts and reconcile read-only. This capability does not itself authorize any real reference-removal operation.

A closing-to-non-closing metadata transition is a narrow exception: with explicit issue/PR/body selection, the author may remove a fully proven intended-only native closing association by updating the body once. Exact PR identity, title, draft/open state, head/ref/base and OPEN issue criteria must remain unchanged; the post-readback must establish native non-closing reference proof and empty closing associations before any delivery action. Dry-run reports a pending transition, not verified non-closing state. Missing closing proof or an already-empty stale body cannot use this exception. An already valid non-closing PR is reused without another body update.

Non-closing delivery refuses closing directives in the current PR title/body and every introduced commit message, including other issues/repositories. Squash is required, with explicit safe title/message sent to GitHub. GitHub’s active required reviews and checks, native blockers, current default base and expected-head merge guards still apply. `finish --non-closing` refuses before any lifecycle call; this mode never closes the retained issue or changes its Project to Done. GitHub does not atomically lock issue intent or external edits with promotion/body/merge: failed acknowledgements or post-read drift require read-only reconciliation, never a blind mutation retry or reopening an issue.

If GitHub creates a draft but association verification fails, the diagnostic reports the created PR identity and the unresolved post-publication phase. Inspect that exact PR read-only before any further action; creation is not repeated to repair an association. A body containing closing words alone never proves the native association.

For a new issue, `start --request-id <stable-id>` records inert retry markers in its body. Retry the same request after an unknown response; matching remote state is recovered, while conflicting intent or duplicate matches refuse. Without an explicit ID, identical tracking inputs share a deterministic retry identity. Supply a new ID for a separate issue with identical inputs. A retry search beyond 2,000 issues refuses and asks for the known issue number. `pr:create --head <branch>` selects an existing linked branch when an issue has several.

Formal review requires a validated independent artifact and the configured reviewer App. The artifact binds author/reviewer identities, exact commit/tree and complete changed-path digest. The review body retains the original artifact and digest for submission integrity and audit. GitHub owns subsequent review eligibility and stale-review dismissal; merge does not compare historical artifact, tree, diff or publication lineage against the current PR. A matching remote review is reused; conflicting actor, head, state or duplicate claims for that same artifact refuse. An older approval does not prevent submission of a new independently validated exact-head artifact. Submission reads back the exact review ID and artifact. Reviews containing only a historical marker require a fresh review. Its new `ai-delivery.github-review@1` receipt is separate from historical local-evidence receipts. CLI `--artifact` reads a UTF-8 JSON file; MCP takes its JSON content.

An App submission does not prove that GitHub counted it. `pr:checks` exposes GitHub’s live review decision, merge state, configured required check names and head check observations. Required names come from applicable native rules and classic branch protection, so checks that have never reported remain visible. Partial requirement discovery is labelled explicitly; head observations do not override GitHub’s eligibility decision. Merge uses GitHub’s eligibility for the exact PR head and current base, including active rulesets, required checks, required reviews and configured up-to-date requirements. A repository requiring zero reviews does not acquire an extra App approval requirement. CLEAN and HAS_HOOKS are eligible; UNSTABLE follows GitHub’s mergeable decision with non-passing commit status; GitHub decides which check results and requirements apply. BLOCKED, BEHIND, DIRTY, unknown or incomplete eligibility and moved head/base refuse with native state and required-check diagnostics. No unresolved native issue blockers may remain. The server merge mutation includes the expected head SHA. Finish confirms the intended PR merged before closing its issue, and retries from remote readback without local receipts.

The optional host-local squash queue uses one configured canonical clone per repository. Linked worktrees share its Git common-directory queue; multiple independent configured clones refuse. Add returns a durable position, status only observes, and an explicit foreground driver advances the queue:

Status includes the recorded process `leaseRoot`. Keep that worktree available while entries or cleanup remain pending; runs from another linked worktree retain the same recovery lease. Once fully drained, a new admission can bind the current configured worktree.

```sh
ai-delivery --repo example/widget --identity author merge queue add 23 --issue 17
ai-delivery --repo example/widget merge queue status
ai-delivery --repo example/widget --identity author merge queue run
```

MCP uses `issue_pr_merge({repo, prNumber, issueNumber?, queue:true})`, `issue_pr_merge_queue_status({repo})` and `issue_pr_merge_queue_run({repo})`. When omitted, the issue is derived from one complete same-repository native closing association. Queue requests reject direct-merge options (`nonClosing`, `reviewedHeadSha`, `strategy`, `dryRun`); omitted or false `queue` preserves direct merge. Enqueue conveys no approval. The configured author owns ref/comment/merge writes. There is no daemon: process loss stops progress until an explicit compatible `run` resumes.

Queue merges require a standing approval. Add the human approver logins to the existing **operator-owned** user configuration, scoped to the repository:

```json
{ "mergeQueueApprovers": { "example/widget": ["maintainer"] } }
```

This optional field does not grant authority through repository files, author/reviewer roles or GitHub organization membership. Missing configuration or an empty list grants no standing approval. Repository names and human login comparisons are case-insensitive; duplicate entries refuse. Running commands retain their captured configuration binding. Configuration changes require a new compatible invocation; delete the approval comment to revoke a running grant.

An approver posts the following **whole comment on the batch's first PR** after every listed PR is queued, in exactly this format:

```text
ai-delivery merge approval v1
repository: example/widget
pull-requests: 23,24,25
conditions: current-native-eligibility,current-queue-checks,predecessors-merged
heads: current-native-eligible
expires: 2026-10-24T00:00:00Z
```

Use a future explicit UTC expiry (`YYYY-MM-DDTHH:mm:ssZ`), strictly after the comment's creation. No expiry is implied. The list contains 1–100 unique positive PR numbers and must match the complete contiguous FIFO prefix. Only CRLF line endings and one optional final newline are normalized; extra prose, fields, expressions, duplicate PRs, unsupported conditions or another heads policy refuse. The three mandatory conditions mean current native GitHub merge/check/review/blocker eligibility, successful complete required checks for the exact queue SHA and producer, and verified earlier merges through the same grant. Native zero-review policy keeps its existing meaning; standing approval never supplies an App review or bypasses protection.

**The approval names PR identities, including later code edits as well as rebases.** Each changed head still requires fresh native eligibility, repository-required review/check proof and a newly valid exact queue-SHA prediction. No additional human grant is needed while those conditions and the expiry hold. This is broader than approving exact commit SHAs.

The queue uses authenticated GitHub comment/author/repository/PR identities and explicit native edit evidence. Non-approvers, expired or edited comments are ignored with a reason on the PR; restoring an edited body does not restore authority. Missing or unreadable proof refuses. An uncovered entry stays `needs-approval` with one comment naming the configured approvers. The queue publishes predictions only for an approved prefix and never skips an uncovered earlier entry. Multiple eligible grants refuse as ambiguous; delete the unwanted one rather than relying on newest/oldest precedence.

Deletion, editing, minimization or expiry prevents later merges. Removed or externally merged predecessors invalidate the remaining grant; post a new unedited approval on the remaining FIFO prefix's first PR. Re-enqueue cannot reuse a comment already bound to old queue entries. Compatible resumes retain the original comment anchor and verified consumed prefix after its first PR merges. Every real `verifying`, `ready`, `merged as <sha>` or `removed: <reason>` transition gets one authored PR comment mentioning the native PR author; repeated polls do not add comments. Rebuilt suffix predictions can produce another genuine verifying/ready cycle. Lost acknowledgements are reconciled by exact authored target/body/operation identity. An absent, duplicate or conflicting uncertain outcome halts without another POST or merge.

The queue record is `ai-delivery.merge-queue@2`. Old schema, runtime or configuration bindings refuse without migration or reset. Resolve an old runtime's queue and retain uncertain-write evidence before changing its binding; deleting its state is not a recovery procedure. Reconciliation/cleanup and notification of an already established merge remain distinct from permission to send a new merge.

GitHub cannot atomically validate a comment or expiry and merge a PR. A revocation or expiry can race the last check and server request, alongside the base race described below. The driver checks again before each new merge and halts on unexpected outcomes. A GitHub standing grant never overrides host-platform admission or a refusal.

For host permissions, the following are **documentation examples only**. Replace the repository and `author` with your configured values through your host's normal policy process. One exact Claude Code allow entry is:

```json
{ "permissions": { "allow": ["Bash(ai-delivery --repo example/widget --identity author merge queue run)"] } }
```

One Codex rule for the same queue-run command family is:

```python
prefix_rule(
    pattern = ["ai-delivery", "--repo", "example/widget", "--identity", "author", "merge", "queue", "run"],
    decision = "allow",
    match = ["ai-delivery --repo example/widget --identity author merge queue run"],
    not_match = [
        "ai-delivery --repo example/widget --identity author merge queue add 23",
        "ai-delivery --repo example/widget --identity author merge queue status",
        "ai-delivery --repo example/widget --identity author pr:merge --issue 17 --pr 23",
        "ai-delivery --repo example/widget --identity author pr:review --issue 17 --pr 23 --artifact review.json",
        "ai-delivery plugin update --host codex --version 0.3.35",
    ],
)
```

Claude's no-wildcard rule matches the full command. Codex matches an argv **prefix**, so trailing options can match; its `match`/`not_match` entries are tests, not additional restrictions. This rule cannot enforce an exact argument count. Neither example allows another ai-delivery subcommand, installs itself, supplies standing merge authority or overrides stricter denials. See [Claude permissions](https://code.claude.com/docs/en/permissions) and [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules).

For a long MCP `run`, clients should request standard progress notifications and reset their stall timeout on progress, without a total request deadline. Notifications report actual queue observations and completed/remaining entries; unchanged waits do not claim additional completed work. Host request limits still apply. The CLI driver emits the same bounded observations to stderr and supports cancellation throughout.

The driver predicts ordered squash trees in an owned inert bare object store and publishes exact SHAs at `ai-delivery/queue/<pr>`. Consumers must arrange their required CI checks on those refs. No hosted queue-SHA qualification is bundled here. Required check discovery, complete current-attempt check/status observations, required App source and exact SHA must all agree. Missing, partial, unknown or non-success proof cannot pass. Git hooks, target configuration, filters, signing, custom merge drivers, policy modules and consumer scripts are never executed by prediction. Expected-object Git ref leases protect creation, replacement and deletion. Conflicts and failed checks remove the entry with PR diagnostics; the remaining suffix is rebuilt. Every actual squash changes the base identity, so suffix predictions need new SHA checks even when their trees match.

Native PR protections remain an additional gate. Strict up-to-date rules can leave a later PR `BEHIND`; its owner must refresh its head and obtain current native checks/review. The queue never rewrites PR heads or transfers check/review authority. An observed native null review decision retains the existing zero-review semantics; unavailable or malformed decisions cannot establish eligibility.

GitHub's merge endpoint pins the PR head, **not the expected base**. The driver rereads the base immediately before sending a merge and then verifies the actual squash's single parent, tree and current main. A concurrent outside writer can still cause an irreversible unexpected merge; this residual race is accepted by Option A. Unexpected parent/tree/main halts the queue without rollback or advancing another PR. Pending write intents survive lost acknowledgements and are reconciled read-only before another mutation; an unestablished outcome halts instead of blindly retrying. Compatible resumes skip completed merges and cleanup. Corrupt state or changed repository/host/configuration/runtime binding refuses reuse. Status exposes pending/halted state. Owned process identity, bounded resources and quiescent cleanup use the existing runtime writer; unresolved mutations retain their queue refs/object evidence for reconciliation.

The removed `develop`, `verify`, `pr:checkout`, worktree creation/cleanup and local velocity record commands are no longer public CLI/MCP workflows. Preserve existing consumer checks, controller admissions and historical custody records. Their original schemas, digest identities, writer locks and operational closure rules remain separate. The legacy transition commands remain exposed, but this runtime cannot reproduce their historical repository-policy configuration binding: CLI/MCP inspection and apply refuse without executing policy or converting records. Complete those transitions with the original controller. Explicit runtime stage/admit remain supported.

For `issue_create` / `create`, supply a stable `opId` / `--op-id` when a write
must be recoverable. Repeat the same original arguments after a partial failure;
the authored issue marker identifies the existing issue and remaining tracking
steps complete without creating another issue. A conflicting intent, author,
closed issue or later tracking change refuses recovery. Keep the same author
and original issue body; the bounded search refuses when its complete window
cannot be read. `epic: true` / `--epic` permits a Ready parent without Points.
State and title edits preserve archived Project items and warn with the item ID.

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
| Reparent one issue | `issue_update` | `update --issue N --parent P` |
| Plan / apply a batch | `issue_batch_update` | `batch:update --items-file <items.json> [--dry-run]` |
| Reconcile Project membership / Status | `board_reconcile` | `board:reconcile --repositories <owner/repo...> [--dry-run]`; retained plan and result JSON for apply/recovery |
| Record a typed journal | `issue_comment` | See the [typed journal contract](#typed-issue-journals); the MCP call returns the authored comment identity and readback |
| Close with a reason | `issue_update` | `update --issue N --state closed --close-reason not_planned --superseded-by S` |

Typed JSON contains the issue contract fields, including Issue Type, Points, problem, outcome, acceptance and non-goals. CLI repository, parent and priority selectors use their documented flags. Issue and PR tools return compact JSON by default: identities, native fields and relationships, warnings, and history-comment links. MCP `verbose: true` restores the complete prior payload, including bodies, conversion diffs and routing; CLI `--json --verbose` does the same. Recovery arguments, refusals and diagnostic fix hints remain available in compact output.

Inspect each result: rewrites return the preserved history comment; creation and reparenting return native readback. Reasoned closure returns `closure` evidence, supersession and the authored comment from `issue_update`; `issue_info` supplies state and Project status without the closure-reason evidence. A successful readiness check does not start an issue.

`issue_create` and `issue_update` also accept optional native `startDate` and
`targetDate` values, including in CLI `--fields-file` JSON. They resolve the
organization fields named **Start date** and **Target date** without caller IDs.
Dates must be calendar-valid `YYYY-MM-DD` strings. Omit a property to preserve
its current value; use `null` to clear only that date. For example, an update
file containing `{"startDate":"2028-02-29","targetDate":null}` sets the start
date and clears the target. Missing, duplicate or incompatible requested date
fields refuse before mutation; calls without date properties do not require
those organization fields. Existing Points/Priority and other field values
are preserved. This adds no date fields to the organization.

`issue_info.fields` returns the same supported organization field names and
values as `issue_list`, including text, number, date and named single/multi-select
values; unset fields are `null`. The existing top-level Points/Priority readback
remains, with `startDate`/`targetDate` aliases when their date fields exist.
Setting fields uses additive native updates; clearing an already unset date is
idempotent. A creation failure after a native issue exists reports that known
issue so recovery never creates a replacement.

For a parent with direct native subissues, `issue_info.childProgress` adds:

| Property | Meaning |
| --- | --- |
| `childCount`, `closedChildCount` | Direct children and children whose native issue state is closed. Descendants are not counted again. |
| `percentClosed` | Closed child count divided by child count, in percentage units rounded to one decimal. It is not weighted by Points. |
| `pointsTotal`, `missingPoints` | Sum of configured Points across all direct children, or `null` with the unavailable children's numbers. Unsafe integer totals refuse. |
| `inProgressChildren`, `missingProjectStatus` | Numerically sorted child numbers with live configured Project Status In Progress, including closed children with that status. If any status is unavailable, membership is `null` and those children are identified. |
| `nextTargetDate`, `undatedOpenChildren` | Earliest calendar date among dated open children, including overdue dates, or `null`; open children without dates are listed separately. Closed-child dates are excluded. |
| `targetDateConfigured` | Whether a date field named Target date exists. If false, the next date is `null` and every open child is listed as undated. |

A complete empty child list leaves `childProgress` absent and preserves the leaf
readback. Missing, archived or unset Project status is unavailable, not inferred
from an open issue. Explicitly unset Points is unavailable; malformed values,
wrong field types, ambiguous identities, cross-repository child relationships,
failed reads and incomplete pagination refuse the aggregate. The read performs
no issue, relationship or Project writes. CLI, MCP and library readback share
these rules.

Batch input is a UTF-8 JSON array of **1–50** complete `issue_update` inputs;
MCP takes `{repo, items, dryRun}`. All items use the selected repository, including
any per-item `repo`. Close, defer/undefer, parent, blockers, typed contract,
status and history/render-retention fields keep their existing validation and
configured author requirements. Dry run performs reads and returns `planned`,
`unchanged` or `failed` results with the desired `changes` and current `readback`;
it writes no issue fields, metadata, relationships, Project state or comments.

Execution is serial and returns every item in input order as `applied`,
`unchanged` or `failed`, plus readback and summary counts. Failure can follow a
partial native write: inspect its readback before retrying. An unavailable
readback is explicit, never evidence that nothing changed. Rerun the same inputs
to reconcile actual state; already satisfied fields and related outcomes are
unchanged, and authored comments/history are deduplicated. This operation has no
cross-repository transaction or rollback. CLI prints the complete JSON and exits
nonzero if any item failed. A positively identified GitHub rate limit stops
further writes and gives every remaining item an explicit failure reason;
`summary.rateLimits` contains only available numeric retry-after/reset/remaining
observations. No uncertain mutation is automatically replayed.

Creation includes five status fields: Ready or Draft, last updated in UTC,
next milestone (default `Not started`), native blocker numbers (or `None`),
and latest journal (`None yet`). Supply `status: {"nextMilestone":"Run checks"}`
on `issue_create`; `issue_update` also accepts display-only `status.blockers`
and `status.latestJournal`. The same objects work in CLI `--fields-file` JSON.
Status values are single lines rendered as literal text. Status-only patches
preserve every byte outside Status, including canonical data and start markers;
no-op patches keep the timestamp. Display blockers create no dependency edges:
use native `blockedBy` for those, and do not combine it with `status.blockers`.
Convert handwritten legacy bodies explicitly before applying a status-only patch.
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

`src/currentTrackingScenario.test.ts` composes these operations through one real SDK client/server session outside Git. Only external GitHub/auth ports are synthetic; settings, discovery, schemas, dispatch and owners run normally. Stored issue fields, parent membership, exact escaped history whitespace, comments, explicit deferral/undeferral, closure and configured Project Done are checked after writes. Invalid schemas and unsupported `issue_batch` alias or standalone `issue_defer` requests leave stored state and native write counts unchanged. This synthetic replay does not complete the broader tracking parent or prove a live backlog replay.

## Deferral and work-in-progress admission

`issue_update` accepts `defer: { until?: "YYYY-MM-DD", trigger?: "condition" }`
or `undefer: true`. An empty `defer: {}` means indefinite manual deferral.
These inputs are mutually exclusive. Conditions are recorded text and dates:
passing the date or satisfying the trigger never automatically resumes work.
Only explicit `undefer` clears deferral; body replacements and unrelated updates
retain it. `issue_info` and `issue_list` return `deferred` with the recorded
conditions, or `null` for known undeferred content. If canonical content is
invalid or a listing omits its body, the field is omitted rather than claiming
that deferral is absent; inspect the body and readiness diagnostics.

Deferral is independent of `draft` and `park`. `park` still pauses execution as
a draft, retains host-owned worktree custody, and uses the existing Todo/Blocked
Project presentation. `undefer` does not clear a parked draft. Deferral alone
does not release an existing In Progress slot. Readiness and supported `start`
refuse deferred work, including a past date, before creating a branch or journal.
The removed `develop` workflow remains removed. Repository labels continue to
accept any existing native label; unknown labels are refused.

```sh
ai-delivery --repo example/widget update --issue 17 --defer --defer-trigger 'Upstream ships'
ai-delivery --repo example/widget update --issue 17 --defer-until 2026-12-01
ai-delivery --repo example/widget update --issue 17 --undefer
```

Optional `wipLimits` in the existing operator-owned user JSON declares lanes.
No target-repository configuration is loaded, and the tool never writes these
settings. Without this option, capacity admission is unchanged. Each lane names
its repository, a name unique within that repository, a nonnegative integer
limit, and exactly one native label or named native issue-field value:

```json
{
  "wipLimits": [
    { "repository": "example/widget", "name": "Review", "match": { "label": "Needs Review" }, "limit": 2 },
    { "repository": "example/widget", "name": "Urgent", "match": { "field": "Priority", "value": "High" }, "limit": 1 }
  ]
}
```

Label matching follows native case-insensitive label names. Field names and
string values match exactly; numeric fields compare numbers and multi-select
fields match a member. Unknown labels/fields, changed identities, malformed or
unreadable data, repeated/nonadvancing pages and incomplete bounded readback
refuse admission. Counts include open issues in the selected repository with
the configured Project's In Progress status. Verified absent membership or an
explicitly unset native Status consumes no slot; omitted Status evidence refuses. Every matching lane must have
capacity. An already In Progress target consumes no additional slot on retry.

`start --override-reason <reason>` / `issue_start.overrideReason` can override
capacity only. The configured authenticated author must record and verify the
exact issue, Project, native field identity, lane counts/limits and reason in
an issue comment before advancement. The reason cannot bypass deferral, draft,
native blockers, tracking-parent eligibility, access or review requirements.
An uncertain comment acknowledgment is reconciled against the same authored
comment; a changed observation refuses advancement and requires fresh readback.

Capacity is read completely before branch creation and rechecked immediately
before Project advancement. GitHub exposes no conditional cross-writer Project
capacity transaction: these are fresh observed-capacity guards, with no global
atomic WIP guarantee against concurrent native writers. A later refusal can
leave the already-linked branch intact; use the returned `safeResume.arguments`
with its reason and preserve that native identity. Refusals publish no Started
journal. `src/issueIntake.test.ts` exercises current CLI/MCP/SDK deferral and WIP
paths with synthetic native ports; it makes no live override or deployment claim.

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

## Scoped Project reconciliation

`board_reconcile` uses the same dispatcher as the library's existing `executeTool`
and CLI `board:reconcile`. Supply 1–10 explicit `repositories`; the command never
infers this scope from launch-directory Git. An optional singular `repo` must agree
with the sole selected repository. Dry-run is the default and requires read access
through the configured author. Apply requires fresh write access through that same
author and refuses the legacy development-token override.

The dry-run `ai-delivery.board-reconcile-plan@1` includes every selected native
issue, current membership/Status, native facts, gaps, metadata suggestions and
deterministic operations. These operation artifacts remain under `ai-delivery.mcp@2`.
Bounds are 500 native issues per repository, 20 requests per logical prerequisite
collection (including its completion page), and 16 MiB UTF-8 for retained JSON
inputs and structured output. An overflow or unreadable inventory produces an
incomplete report; it never authorizes a truncated-scope apply. These bounds do not
claim an HTTP response-byte or process-memory ceiling.

Open issues may receive missing membership independently of Status. Status follows
proven native closure, open blockers, canonical draft/deferral, then positive local
checkout evidence with readiness and WIP admission. `checkouts` (CLI
`--checkouts-file`) selects absolute physical checkouts for native-linked current
branches inside configured roots. A checkout does not prove a running task, and
missing activity evidence does not prove inactivity. Unknown Status remains
unresolved, archived items stay preserved, and metadata/duplicate-label suggestions
never repair native fields or labels.

Retain the exact original plan. Apply supplies `mode: "apply"` and `plan` (CLI
`--apply --plan-file`); optional `priorResult` (`--prior-result-file`) preserves known
item IDs and historical attempts on that same plan. Files contain regular UTF-8
JSON data. Scope, artifact bytes, configuration, destinations, inventory and author
are revalidated before writes; operation-specific native and item facts are checked
at both write boundaries and afterward. A compatible exact postimage is satisfied
without repeating the write. A deleted known item or unexpected automatic/human
Status requires a fresh plan. Recovery adds no journal store or automatic rollback.
Plans identify the executing package manifest/dist bytes independently of cwd;
the root library and bundled plugin layouts need fresh plans even at equal versions.

The apply `ai-delivery.board-reconcile-result@1` preserves applied, satisfied,
failed, drifted/refused and unknown-after-attempt evidence. A failed shared Project
group stops its dependents; independent groups may finish. Global cancellation,
authentication or rate-limit failure stops remaining writes. The CLI prints complete
compact JSON before exiting nonzero for incomplete scope or unresolved apply work.
A complete dry-run can exit zero with explicit issue gaps and metadata suggestions.
GitHub provides no expected-current-value predicate for these mutations: observable
drift is detected, while races with outside writers can remain ambiguous.

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

Successful tracked `issue_start` calls publish one start
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
