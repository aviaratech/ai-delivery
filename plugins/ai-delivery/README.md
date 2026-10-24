# ai-delivery plugin reference

This is the detailed operational reference for the package README and three bundled skills. Read the applicable sections before acting. Repository and operator instructions still own authority, checks and production boundaries. The [scope charter and full command/tool map](../../README.md) describe the public surfaces; command help and exported MCP schemas supply exact current inputs.

## Native installation

The complete plugin is the canonical Codex/Claude Code installation. Its launcher starts the adjacent `runtime` CLI and bundled dependencies without a parent npm installation, source build or postinstall. Portable `plugin.json`/`mcp.json` coexist with Claude's `.claude-plugin/plugin.json`/`.mcp.json`. Package, CLI, server and manifests share a version; application and dependency notices ship with the plugin.

Use a qualified published version or reviewed archive. Native installation is an explicit operator-authorized action:

```sh
ai-delivery plugin install --host codex --scope user --version <published-version>
ai-delivery plugin doctor --host codex --scope user --json
ai-delivery plugin preview --host claude-code --scope user --json
```

Claude supports user/project/local scopes; Codex supports user scope. `update` requires an explicit version; `rollback` selects the recorded previous version. `remove` and retention cleanup preserve unowned installations and persistent data. Inspect the selected target and managed ownership before a mutation. `--dry-run` describes the intended operation without applying it. No automatic npm cleanup or mandatory hook is installed.

Preview reads bounded configuration candidates without invoking native tools/server or creating settings, backups, locks or checkpoints. Its migration status is refused and changes are empty. Doctor may observe an external marketplace installation without adopting it or starting an unknown launcher. Neither command restores/deletes per-plugin or per-tool preferences. Unknown versions/scopes stay unknown; Codex table observations are not a TOML/profile resolver, and Claude custom-profile configuration is unverified.

Standalone MCP registration remains legacy support for at least two subsequent stable releases **and 90 days after a qualified migration path first ships**. The release/date anchor is unknown; diagnostics starts no clock. Live migration, settings rollback, adoption and retirement remain unavailable until exact ownership, lossless settings preservation and native writer exclusion are proved. Manifest qualification is distinct from native adoption ([#116](https://github.com/aviaratech/ai-delivery/issues/116)).

Installed bytes, a separate doctor startup and the conversation's loaded version are different evidence. Follow the selected host's activation guidance and read back its actual version; a successful standalone launch does not prove GUI environment propagation. Plugin installation grants no private runtime activation or custody adoption.

## Credentials and readiness

Operator JSON lives at `~/.config/aviaratech-ai/ai-delivery.json`, or the absolute `AI_DELIVERY_CONFIG` path. Required keys are `schemaVersion: "ai-delivery.user@1"`, author/reviewer roles, organization `project` number and `checkoutRoots`. No consumer-repository policy/config file is required. Native organization metadata supplies Issue Types, Points/Priority and Project IDs/options. Optional field/status names customize defaults: Points, Priority, Status and Todo/In Progress/Blocked/Done.

The author and reviewer have distinct configured identities and authenticated actors. A personal author names a token variable through `credentialEnv.token`. For `GH_TOKEN` only, an absent variable selects the existing active `gh` user. An explicitly supplied empty, malformed, expired or denied token fails without switching actors. A custom reference always requires its value. Ambient `GITHUB_TOKEN` and unrelated credentials do not replace the selection. Git author metadata is not authentication.

Machine authentication resolves `gh` on the actual process PATH, without a shell profile, current-directory search or hardcoded executable. It privately reads the selected active github.com account and token, verifies healthy state and actual user match, and forwards only necessary non-secret home/PATH/config selectors. Other account failures do not invalidate a healthy selected user; combined `gh auth status` failure alone does not prove that selected route is unhealthy. Missing/ambiguous sessions, keyring failure, host mismatch and identity drift refuse without login, switch, refresh or permission grants. Raw token/status/error data remains private.

The package supports `github.com` only; enterprise selectors/conflicting `GH_HOST` refuse. `GH_CONFIG_DIR`/`XDG_CONFIG_HOME` preserve their selected locations. The native launcher inherits its host environment; it does not read shell profiles, `.env`, repository settings or a secret manager. A terminal export does not update an already running GUI host. Use the host's supported server `env`/forwarding mechanism and verify that its actual process receives the intended references. Claude-specific option expansion is not a portable Codex setup mechanism.

Legacy App roles name App ID, installation ID and private-key references in `credentialEnv`; their existing configured artifact-review route remains available. Explicit reviewer profiles also bind `provider`, `appId`, `installationId` and `actorLogin`. The standalone `review submit`/`review doctor` surface requires that explicit profile shape; it may reject a legacy role even when the maintained artifact route works. Diagnose that contract difference instead of changing actors, creating a credential route or silently repairing settings.

Explicit App profiles use exactly their selected credential source: default/env, protected file or configured argv command. The default reviewer references include `DELIVERY_REVIEWER_APP_ID`, `DELIVERY_REVIEWER_INSTALLATION_ID`, and absolute `DELIVERY_REVIEWER_KEY_PATH`; App authors have their own references. Protected-file/command sources never fall back to env. Command argv[0] must be absolute, arguments are literal and optional forwarded environment is bounded. There is no tilde, `$USER`, pipeline or shell interpolation. PEM or canonical base64 input must decode to an unencrypted RSA key, retained only in memory. Credential requests have a 30-second operation limit, 64 KiB combined capture and identity-safe cleanup; native Windows command sources refuse. These are credential-operation bounds, not a task deadline. Never print keys or supply author credentials as the reviewer.

Set `credentialSource` inside the explicit reviewer profile, for example:

```json
{ "type": "env", "variable": "MY_REVIEWER_KEY", "encoding": "base64" }
```

```json
{ "type": "file", "path": "/absolute/operator-owned/reviewer.pem" }
```

```json
{ "type": "command", "argv": ["/absolute/credential-helper", "reviewer-key"], "encoding": "pem", "env": ["HELPER_SESSION"] }
```

File sources require a regular non-symlink file, current-user ownership where supported, one hard link and exactly mode0600; they do not repair permissions. Windows file-permission equivalence is unqualified; use env there. Commands are trusted operator configuration, not a sandbox; only bounded OS selectors and explicitly listed helper environment reach them. Author tokens, other App keys and executable-injection selectors are excluded. Use an existing authenticated helper session and only its needed selectors. Optional top-level `reviewerProfiles` maps names to complete explicit profiles; each key equals its identity and differs from the author. `--identity` selects exactly one source. These examples provision no credential or host setting.

```sh
ai-delivery --repo example/widget config:resolve
ai-delivery review doctor --identity delivery-reviewer
```

`config:resolve` reads routing, authenticated author and reviewer access/rule evidence. `review doctor` mints the selected installation token and reads the App, without a checkout, Project discovery or posting a review. Installation permissions need at least contents:read and pull_requests:write. Default plugin doctor does not authenticate the author session. Configuration/reference presence is not access proof; read access is not future write permission, and App authentication is not counted approval.

## Issue reads and tool discovery

For an ordinary read, discover the requested installed provider, inspect its schema and pass the user's `repo: "owner/name"`. Reads, lists and searches work outside Git with no issue creation contract, readiness call or start. One server can switch repositories per call.

In Claude Code, a plugin-qualified tool may coexist with a bare tool. The observed installed read is `mcp__plugin_ai-delivery_ai-delivery__issue_info({repo, issueNumber})`; discover the actual host name instead of hardcoding it everywhere. An issueNumber/cached-only schema without `repo` is a different contract. Adding an unsupported field does not select a repository.

Honor selected-provider, read-only and MCP-only restrictions. If the requested compatible provider is unavailable, report the limitation and stop that read; do not switch directories/providers, substitute a CLI, change registrations or alter credentials. Otherwise the installed CLI is a supported fallback when MCP is unavailable and the operator permits it. Record actual selected tool/schema/arguments/result; installed guidance alone does not prove provider choice or loaded version.

## Issue contracts

Issues use `ai-delivery.issue@1`: problem, outcome, acceptance entries `{behavior, verifiedBy}`, non-goals, open questions, native Issue Type and Points. Bugs add reproducible steps, expected/actual behavior, environment and regression proof. Resolve open questions before execution; tracking parents and issues with open native blockers cannot start autonomously. Size work using configured native Points; split a 13-point issue. Keep public fields free of secrets.

Typed `issue_create`/`issue_update` validation returns field/code/fixHint diagnostics before rejected writes. Drafts may be incomplete but reject secrets. The exported `AI_DELIVERY_MCP_TOOLS` create definition exposes Draft/Ready structural schemas; Zod also checks semantics, so structural validation alone is not readiness. Inspect native title/body/type/Points/Project state/parent/blockers before updates. Preserve all original acceptance and history when correcting intake.

Read `issue_info` and `issue_ready_check` before `issue_start`. Ready evaluates typed/native work state, not local path or a runnable-command requirement. Starting creates/reuses the linked branch; the host owns the local worktree. A partial creation returns the known issue/branch and recovery information: resume that identity instead of creating a replacement.

Canonical bodies contain Ready/Draft, UTC updated time, next milestone, native blockers and latest journal. Create accepts `status.nextMilestone`; update also accepts display-only blockers/latestJournal. Status-only updates preserve every byte outside Status, including contract/start markers, and no-ops retain timestamps. Display blockers do not create native edges; use `blockedBy` separately and do not combine those selectors. Convert legacy bodies explicitly before a status-only patch. Readable text above 4,000 characters warns; embedded data is excluded.

`preserveHistory` controls an exactly read-back authored snapshot of the old title/body. `retainLegacyBody` independently controls readable legacy text, without erasing embedded history or comments. Default conversion/first omission preserves history first; incoming bytes absent from history stay visible. With history disabled, unpreserved text remains unless explicitly dropped. Repeated no-ops do not grow history. Failed readback or concurrent drift refuses the rewrite. Missing proof is reported, never invented.

`startDate`/`targetDate` accept calendar-valid YYYY-MM-DD values, omission preserves and null clears. Native organization date fields are discovered by name; missing/duplicate/incompatible requested fields refuse before mutation. Unrequested fields and existing native metadata remain untouched. `issue_info.fields` exposes supported organization values; unset values are null. Its optional direct-child progress counts direct children once, reports Points/status/date gaps explicitly and refuses incomplete or conflicting relationships; unavailable evidence is not inferred from open state.

### Batches, deferrals and Project reconciliation

`issue_batch_update`/`batch:update --items-file` takes 1–50 complete selected-repository updates. Dry run performs no writes. Execution returns every applied/unchanged/failed result and readback, including partial native failure, with nonzero CLI status on failure. Reconcile original state before retry; satisfied outcomes/comments are reused. There is no cross-repository transaction or rollback. Positively identified rate exhaustion stops remaining writes and reports only numeric timing/limit observations.

`defer` uses a valid date and/or observable trigger; `undefer` is explicit and mutually exclusive. Deferral preserves work history; parking preserves remote tracking and leaves local cleanup to the host. Work admission uses native blockers, configured WIP lanes and explicit override reasons, not silently changed capacity. Health/board views report attention and unavailable evidence without mutating state. A board decision label is a read filter, not operator approval.

`board:reconcile` defaults to dry run over explicit bounded repositories. Review its retained exact plan before separately authorized apply; files are regular UTF-8 JSON, bounded to 16 MiB. Preserve original plan/result identity and partial readback for recovery. Conflicting, incomplete or changed scope refuses instead of guessing. Do not replace the original uncertain attempt with a fresh mutation. Missing Project/rule visibility stays unknown.

## Typed journals

`issue_comment` accepts common fields: issueNumber, kind, one-line summary, status, nextStep, nullable nextDate, keyNumbers and evidence; optional details/lengthCap. Evidence uses public HTTPS DNS hosts without credentials, local hosts or IP literals. The five kinds add:

| Kind | Required fields |
| --- | --- |
| start | outcome |
| progress | nonempty done/evidence, decisionNeeded |
| decision | nonempty decision and rationale |
| blocker | blocker and resolution |
| closeout | nonempty acceptance criterion/evidence entries, followUps |

Omit fields belonging to another kind. Invalid requests refuse before native writes with actionable missing fields. The visible first line contains bounded plain status/next-step previews and the complete summary. Full values, canonical labels/order and the journal marker remain intact. Excess fields move to the existing details wrapper. Old journals remain readable; forged/ambiguous structure remains unknown. Posting reads back the authored comment identity and recovers uncertain responses without duplicates.

## Authority and recovery

Before delegated mutations, identify the operation/side effects, repository, issue/PR, branch, exact head/current base and author/reviewer route. Keep original operator approval, communication scope, technical admission, access, independent review, counted approval and execution receipts separate. Inspect the original native human instruction when needed; label quotations/relays honestly. A registry match, START, role flag, dry run, successful checks or App permissions cannot expand scope. Reuse an already verified grant covering the action without another milestone approval.

Missing authority leaves the dependent write pending while independent authorized work continues. Preserve holds and platform refusals. A denied delegation delivered no instruction: do not change actors, use indirect execution or reroute it. After an admitted retry is refused, make one concise action-specific native-user request identifying the refusal/source. The request grants no retry; resolve its concrete cause and revalidate authority first. A read-only network error alone proves neither a permission refusal nor invalid credentials.

An uncertain acknowledgment can follow server success. Keep attempted/delivered/executed states distinct, preserve known operation/head/IDs and reconcile original supported receipts/native state before continuing. Confirmed success is recorded once; unknown state admits no duplicate mutation, automatic rollback, reopen or blind retry. No skill adds a second coordination or permission mechanism.

## Nonclosing pull requests

Read this section before a partial-delivery publication. Ordinary closing publication uses `issue_pr_create` dry run, configured author/rule readback and then one draft from the pushed linked branch. Hosts own source commits/pushes.

New nonclosing publication requires a concrete original human grant for the canonical OPEN issue, exact linked branch/head, current default base, configured author and complete intended title/body. Bind it prospectively to the one draft returned by that invocation. Use a safe `References #N` body without closing directives, `nonClosing: true`, `reconcileNonClosingReference: true`, exact `expectedHeadSha`/`expectedBaseSha` and draft state. Bare nonClosing refuses before creation. The flag requests a native action; it does not establish authority.

The runtime creates at most one draft and removes at most one exact intended manual closing pair per invocation, after complete all/manual and authorized cross-reference proof. An already safe graph needs no removal. Strict nonclosing verification must pass afterward. Foreign/mixed/incomplete/drifted graphs refuse. The action does not unlink the branch, rewrite the body, promote, review, merge or close the issue. Dry run is pending scope, not verified publication.

The grant must acknowledge the non-atomic boundary: a draft/closing edge can remain after failure, GitHub provides no expected-head CAS for removal, and external edits can race readbacks. Preserve attempt and unresolved identities; reconcile read-only without automatic retry, replacement draft, rollback or issue reopening. Source-delivery approval alone does not authorize reference removal.

Callers own original approval/provenance/attempt receipts; runtime does not deduplicate history across invocations. An explicit existing `prNumber` selects only the caller-admitted unchanged draft, not request provenance. A terminal pre-action non-attempt may permit admitted continuation; arbitrary crash/unknown creation does not. After uncertain removal, an exact safe graph may be reused without mutation. A remaining/reappeared edge or missing history blocks another removal unless authoritative non-execution proof supports admitted continuation or fresh human authority names the exact current pair and unresolved prior attempt.

Keep nonClosing through review and guarded `pr:merge`, which retains the issue OPEN. `finish` refuses this mode. Do not use a closing command or close the full issue to deliver a partial slice.

## Independent review

Run the repository's own proportionate contributor checks. For this repository use fast checks plus explicit focused compiled tests and only the needed plugin build; full local suites or release qualification are separate. Retain omissions and historical failures honestly. Local success does not replace required green CI for the reviewed candidate/current base.

Obtain an independent read-only review of the exact remote commit, tree and complete diff. The configured distinct reviewer App must satisfy repository identity/protection rules. Explicit-profile `review submit` consumes a strict `ai-delivery.review-verdict@1` UTF-8 file, at most 64 KiB, then constructs the hashed artifact bound to its verdict-file SHA256. The existing `issue_pr_review`/`pr:review` artifact route supports established role configurations. Select the applicable maintained route; a stricter standalone profile refusal does not authorize a credential/config workaround.

Record requested/effective model/provider/effort honestly, elapsed time and findings. Unknown fields, missing metadata, provider mismatch and stale head/tree/scope refuse. Never fabricate model or historical policy/evidence receipts. The reviewer validates its artifact against the actual remote state; builder self-checking is not independent acceptance. Request-changes posts REQUEST_CHANGES and grants no approval.

Inspect review identity and live required-review decision: `still-required` is not counted approval. Ambiguous submission retains any known review ID/URL plus head/artifact; reconcile that original review before another submission. A matching acknowledged review is reused. Promotion is a separate authorized operation through `issue_pr_create`; review submission itself does not promote the PR.

Promote only the unchanged reviewed PR through `issue_pr_create` with draft false. Fresh native GitHub checks/protection/current-base eligibility guard merge at the reviewed SHA. Resolve BEHIND, conflicts, BLOCKED, failed/stale/missing required checks or incomplete evidence before mutation. Optional checks do not become required; a zero-review rule does not invent another App approval requirement. Stale/dismissed reviews require refreshed proof. A changed source needs fresh proportionate verification/review and authority-scope reconciliation. Finish confirms the intended PR merged before closing a complete issue; hosts own local cleanup.

## Merge queue

The host-local canonical repository queue accepts `merge queue add <pr>`, reports status and drains with `merge queue run`. Enqueue uses the guarded merge tool's queue mode. Serial integration still requires current native review/check/base/association evidence; queue membership is not approval. Preserve cancellation, unknown-state readback and exact operation receipts. Repository rules and explicitly reserved release/qualification windows still govern protected-main changes.

## Retained controller and compatibility commands

Runtime staging/admission, legacy transitions and installer migration are still shipped; this documentation slice removes no module or state. Stage/admit are explicit local controller operations with reviewed archive/source identity, resource and admission boundaries. Plugin installation alone never activates a private runtime. Preserve original receipts, artifact accounting, writer exclusion, holds and current supported capability checks; unknown custody is not reconstructed from a directory or compact tool output.

Legacy transition inspect/apply retain their separate contract: original bytes/accounting, exact independently accepted plan, native personal-operator relinquishment, distinct reviewer-App acceptance, complete immutable inventory, runtime admission and quiescent writers. The public CLI/MCP cannot reconstruct historical repository-policy bindings and refuses those transitions; use the original controller for supported successful execution. Retained engine tests do not establish public-entrypoint compatibility. No private adoption, shared admission, launcher change, hold release or protocol retirement is granted by a bundled skill.

Local runtime/transition selection requires a matching origin: current matching checkout wins; otherwise configured exact roots or immediate clone children are searched, deduplicating physical paths. Zero/multiple matches refuse; an explicit repo-root selects the intended matching clone. Git probes disable hooks, filters, fsmonitor and external conversions. Remote delivery performs no checkout, push or worktree mutation. Offline legacy migration plans from supplied inventory and does not grant live migration authority.

## Contributor and release evidence

[CONTRIBUTING.md](../../CONTRIBUTING.md) owns toolchain, focused-check selection, retained results, cancellation/quiescent cleanup, required current CI, confidentiality scans and protected release qualification/publication. Each packaged-file edit changes the candidate; preserve earlier accepted archives and independently qualify any new exact release. Built, verified, merged, published and adopted are distinct states. An installed directory or source PR is not release/consumer proof.
