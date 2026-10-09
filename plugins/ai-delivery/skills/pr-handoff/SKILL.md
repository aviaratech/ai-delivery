---
name: "ai-delivery:pr-handoff"
description: Publish a GitHub-linked change, submit exact-head independent App review and complete guarded delivery.
---

# Pull request handoff

Run contributor checks through the repository's normal workflow. Keep the resulting commit unchanged through publication and independent review; a changed head requires fresh checks and review.

Call `issue_pr_create` with explicit `repo`, issue number, a non-empty body and `dryRun: true`. Inspect configured actor and rule evidence, then create a draft from the GitHub-linked branch. Hosts own commits and pushes. Resolve missing credentials or same-actor routes; unknown approval eligibility is not approval.

Obtain a read-only independent review of the exact remote commit, tree and complete diff. Submit its artifact with `issue_pr_review` using the configured reviewer App. A matching review is reused. Inspect GitHub's live required-review decision and checks; submission alone does not prove the approval counted. Resolve stale/dismissed reviews, blockers, failed checks and moved heads or bases without relaxing protection.

Promote the unchanged PR using `issue_pr_create` with `draft: false`. Finish only with satisfied GitHub requirements and fresh CLEAN eligibility. The merge mutation uses the independently reviewed SHA; finish confirms the intended PR merged before closing its issue. Hosts retain responsibility for local worktree cleanup.

```sh
ai-delivery --repo <owner/name> pr:create --issue <number> --body-file ./pr-body.md --dry-run
ai-delivery --repo <owner/name> pr:create --issue <number> --body-file ./pr-body.md
# Obtain independent exact-head review.
ai-delivery --repo <owner/name> pr:review --issue <number> --pr <number> --artifact ./review-artifact.json
ai-delivery --repo <owner/name> pr:create --issue <number> --ready
ai-delivery --repo <owner/name> pr:checks --pr <number>
ai-delivery --repo <owner/name> finish --issue <number> --pr <number> --reviewed-head <reviewed-sha>
```

CLI `--artifact` is a UTF-8 JSON file path. MCP takes the JSON content. Never fabricate effective model metadata or historical policy/evidence receipts. The artifact and counted independent App approval must bind the exact delivered head.
