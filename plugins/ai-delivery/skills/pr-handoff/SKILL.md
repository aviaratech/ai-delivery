---
name: "ai-delivery:pr-handoff"
description: Publish a verified change, submit independent review evidence, and complete guarded pull request delivery.
---

# Pull request handoff

Use the verified commit and its evidence throughout publication, review, and merge. If the commit changes, verify the new commit and obtain review for its exact pull request head.

## MCP tools first

1. Run `issue_verify` on the committed change.
2. Publish it as a draft with `issue_pr_create`, then inspect it with `issue_pr_info` as needed.
3. Obtain an independent review of the exact pull request head and submit its evidence with `issue_pr_review`.
4. Once the approval and required checks are present, promote the pull request and use `issue_finish` to complete guarded delivery and cleanup.

Missing or stale evidence, a changed head, failed checks, conflicts, or unresolved blockers require resolution before continuing.

## CLI fallback

```bash
ai-delivery verify
ai-delivery pr:create --issue <number>
# obtain independent review of the exact pull request head
ai-delivery pr:review --issue 17 --pr 19 --artifact ./review-artifact.json
ai-delivery pr:create --issue <number> --ready
ai-delivery finish --issue <number> --pr <number>
```

For the CLI, `--artifact` is the path to a UTF-8 JSON review artifact file, not inline JSON. The MCP `issue_pr_review` tool instead takes the JSON content as its `artifact` argument. The content is validated against the review artifact schema before submission.
