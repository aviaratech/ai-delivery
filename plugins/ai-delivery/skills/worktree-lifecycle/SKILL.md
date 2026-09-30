---
name: "ai-delivery:worktree-lifecycle"
description: Prepare an issue-backed or explicitly standalone worktree, develop there, and verify the resulting commit.
---

# Prepared worktree lifecycle

Use a registered prepared worktree for implementation so changes and delivery evidence stay associated with the intended issue.

Before development, run the read-only `ai-delivery --identity <configured-author> config:resolve` in the selected checkout, or use `--identity personal --personal-auth config:resolve` for the explicit development override under an App author policy. Inspect the selected author and independent reviewer actors, credential sources, repository access and available review rules. Resolve missing credentials or actor/repository mismatches before preparing work. Unknown approval eligibility remains unknown; runtime admission is still required separately for lifecycle writes. Publication requires the configured author credential.

## MCP tools first

1. For tracked work, inspect the issue with `issue_info`, check it with `issue_ready_check`, then prepare it with `issue_develop`.
2. For explicitly standalone work, use `issue_worktree_create`.
3. Make changes in the prepared worktree, run the focused checks, and commit the change.
4. Run `issue_verify` after the commit. Continue to pull request handoff with the exact verified commit.

To park execution without removing the worktree, call `issue_update` with `park: true` or `ai-delivery update --issue <number> --park`. The Project shows Todo or Blocked from current native blockers; closed/Done remains Done. Resume through `issue_develop`/`develop` with the existing readiness checks. A retained worktree does not establish active execution.

## CLI fallback

```bash
ai-delivery --identity <configured-author> config:resolve
ai-delivery ready:check --issue <number>
ai-delivery develop --issue <number>
# edit, run focused checks, and commit in the prepared worktree
ai-delivery verify
```
