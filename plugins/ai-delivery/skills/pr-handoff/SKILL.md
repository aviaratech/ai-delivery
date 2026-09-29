---
name: "ai-delivery:pr-handoff"
description: Publish a verified change, submit independent review evidence, and complete guarded pull request delivery.
---

# Pull request handoff

Use the verified commit and its evidence throughout publication, review, and merge. If the commit changes, verify the new commit and obtain review for its exact pull request head.

## MCP tools first

1. Run `issue_verify` on the committed change.
2. Call `issue_pr_create` with `dryRun: true` and inspect its `reviewRoute`: selected author and reviewer actors, credential sources, effective reviewer Contents grant, repository access and rule visibility. A visible required-approval rule with a read-only reviewer App grant reports `insufficient-permission`; arrange an eligible independent reviewer or have the operator grant Contents write, accept the installation update and refresh its token before publication. Contents write grants code-write access. Resolve missing credentials or same-actor errors before publication. Unknown grants or rule visibility remain unknown; Contents write is not required merely to submit a review.
3. Publish as a draft with `issue_pr_create`, then inspect the actual PR author with `issue_pr_info` or GitHub readback. The selected author credential must make the push and PR; do not switch to an ambient connector.
4. Obtain independent review of the exact pull request head. Submit its artifact with `issue_pr_review` and the configured reviewer `identity`, so the selected reviewer GitHub App makes the review. Inspect the returned `reviewState`, including `submittedReviewAuthorCanPushToRepository` when available, and the live `reviewDecision`.
5. Promote the unchanged PR with `issue_pr_create` (`draft: false`), inspect live required-review state and checks, then use `issue_finish` only when GitHub requirements are satisfied.

An `APPROVED` review receipt proves submission, not that GitHub counted it. If `reviewState` is `still-required`, inspect the active rule and obtain a qualifying independent approval. Do not repeat the same submission, replace the PR, change actors, or weaken protection automatically. Missing or stale evidence, a changed head, failed checks, conflicts, or unresolved blockers require resolution before continuing.

## CLI fallback

```bash
ai-delivery --identity <configured-author> verify
ai-delivery --identity <configured-author> pr:create --issue <number> --dry-run
ai-delivery --identity <configured-author> pr:create --issue <number>
# obtain independent review of the exact pull request head
ai-delivery --identity <configured-reviewer> pr:review --issue <number> --pr <number> --artifact ./review-artifact.json
ai-delivery --identity <configured-author> pr:create --issue <number> --ready
ai-delivery --identity <configured-author> pr:checks --pr <number>
ai-delivery --identity <configured-author> finish --issue <number> --pr <number>
```

For the CLI, `--artifact` is the path to a UTF-8 JSON review artifact file, not inline JSON. The MCP `issue_pr_review` tool instead takes the JSON content as its `artifact` argument. The content is validated against the review artifact schema before submission.
