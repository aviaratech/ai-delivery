---
name: "ai-delivery:worktree-lifecycle"
description: Prepare an issue-backed or explicitly standalone worktree, develop there, and verify the resulting commit.
---

# Prepared worktree lifecycle

Use a registered prepared worktree for implementation so changes and delivery evidence stay associated with the intended issue.

## MCP tools first

1. For tracked work, inspect the issue with `issue_info`, check it with `issue_ready_check`, then prepare it with `issue_develop`.
2. For explicitly standalone work, use `issue_worktree_create`.
3. Make changes in the prepared worktree, run the focused checks, and commit the change.
4. Run `issue_verify` after the commit. Continue to pull request handoff with the exact verified commit.

## CLI fallback

```bash
ai-delivery ready:check --issue <number>
ai-delivery develop --issue <number>
# edit, run focused checks, and commit in the prepared worktree
ai-delivery verify
```
