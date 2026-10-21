---
name: "ai-delivery:pr-handoff"
description: Publish a GitHub-linked change, submit exact-head independent App review and complete guarded delivery.
---

# Pull request handoff

## Before delegated PR mutations

Identify the intended operation and side effects, repository, issue/PR, branch, reviewed head, current base, and configured author/reviewer route before sending its mutation instruction. Keep original operator authorization, communication permission, technical admission, configured access, independent review, counted approval, and actual execution receipts separate.

Preserve the original native operator instruction and its scope. Reuse a verified grant that already covers the action; ordinary phase admission does not require another operator approval. Label quotations and cross-task relays honestly, including whether the original was inspected directly or verified by another task. A relay, registry match, START, role flag, successful checks, App permissions or dry-run adds no operator authorization. Inspect the original through an authorized route when needed to resolve origin or scope. Use the existing orchestration workflow for provenance and recipient binding; this skill adds no coordination or permission mechanism.

Missing or ambiguous authority leaves the affected mutation pending while independent authorized work continues. Request only the concrete missing scope through the appropriate authorized native user context, naming the operation, repository/PR/head/actor route and any hold or rejection. Already authorized actions need no redundant request. A host refusal remains a refusal even when standing authority exists; these instructions do not guarantee platform acceptance.

Preserve each attempted, delivered and executed state, exact rejection reason and actually admitted retry. A denied delegation delivers no instruction and stops its dependent mutations; do not switch actors, use indirect execution or another route to evade it. After an admitted retry is refused, make one concise action-specific native-user request identifying the refusal and its source. The request itself admits no retry: reconcile the concrete cause and current authority before any permitted continuation. Retain earlier failed attempts as failed. Do not repeat successful preflight merely to restate evidence; refresh the live safeguards required by the pending action.

A failed or uncertain mutation acknowledgement can follow server success. Reconcile the original operation through supported read-only receipts and the same PR's native state before deciding what remains pending. Record confirmed success once; unknown state admits no duplicate mutation. A read-only network failure alone establishes neither an authorization refusal nor invalid credentials.

Fictional `example/widget` PR23 at reviewed head H and base B illustrates these boundaries; these are decisions, not platform tests:

- A lead quotes approval with a source ID: retain it as relayed evidence and resolve original scope when needed; the quote is neither local authentication nor an execution receipt.
- Checks, App access and review dry-run pass with no verified operator grant: submission remains pending and no approval has counted.
- Delegation and its admitted retry are refused: preserve both undelivered attempts, stop dependent writes and make the single precise native-user request without changing actor or route.
- The original operator grant covers App submission and promotion: resume only pending admitted operations, read back the exact review and counted approval before promotion, and reconcile an uncertain acknowledgement before retrying. Merge needs its own coverage within the grant and the existing exact-head, current-base, protection, checks, association, serial-lane and native GitHub eligibility guards. Changed source requires fresh verification/review and reconciliation of authority scope.


Run contributor checks through the target repository's own policy. Under a fast-local/focused-test and CI-gated policy, record the explicit changed-contract test selection, only the necessary build, and omitted full-suite/package proof; do not implicitly install dependencies or repeat full local qualification. This repository's example is `npm run checks:fast -- --test-file dist/path.test.js`, not an unconditional command for other repositories. Preserve historical full-local failures as diagnostic evidence, without adding a blanket merge gate. Keep the resulting commit unchanged through publication and independent review; a changed head requires fresh proportionate checks and review.

Call `issue_pr_create` with explicit `repo`, issue number, a non-empty body and `dryRun: true`. Inspect configured actor and rule evidence, then create a draft from the GitHub-linked branch. Hosts own commits and pushes. Resolve missing credentials or same-actor routes; unknown approval eligibility is not approval.

Obtain a read-only independent review of the exact remote commit, tree and complete diff. Submit its artifact with `issue_pr_review` using the configured reviewer App. A matching review is reused. Inspect GitHub's live required-review decision and checks; submission alone does not prove the approval counted. Required CI must be successful for the current reviewed candidate and current base under the existing native merge contract. Failed, missing or stale required CI cannot be replaced by fast/focused local results or an old package qualification. Resolve stale/dismissed reviews, blockers, failed required checks and moved heads or bases without relaxing protection.

Promote the unchanged PR using `issue_pr_create` with `draft: false`. Finish only with fresh native GitHub eligibility at the exact head and current base. GitHub owns required checks, review counts, stale-review dismissal and configured up-to-date rules. `pr:checks` reports native required check names/statuses; resolve BLOCKED, BEHIND, conflicts, unknown or incomplete evidence before mutation. A zero-review rule does not require an extra App approval; an optional failed check does not become required. The merge mutation uses the independently reviewed SHA; finish confirms the intended PR merged before closing its issue. Hosts retain responsibility for local worktree cleanup.

```sh
ai-delivery --repo <owner/name> pr:create --issue <number> --body-file ./pr-body.md --dry-run
ai-delivery --repo <owner/name> pr:create --issue <number> --body-file ./pr-body.md
# Obtain independent exact-head review.
ai-delivery --repo <owner/name> pr:review --issue <number> --pr <number> --artifact ./review-artifact.json
ai-delivery --repo <owner/name> pr:create --issue <number> --ready
ai-delivery --repo <owner/name> pr:checks --pr <number>
ai-delivery --repo <owner/name> finish --issue <number> --pr <number> --reviewed-head <reviewed-sha>
```

CLI `--artifact` is a UTF-8 JSON file path. MCP takes the JSON content. Never fabricate effective model metadata or historical policy/evidence receipts. Validate the supplied artifact against the exact remote commit/tree/diff before App submission and verify its review readback. Merge then follows GitHub’s current eligibility without rechecking historical embedded artifact identities or publication lineage. Repository-specific independent review requirements still apply.
