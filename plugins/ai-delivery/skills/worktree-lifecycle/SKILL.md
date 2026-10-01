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

For an unwitnessed legacy issue row, use the read-only `issue_worktree_transition_inspect` with purpose `active-resume` or `merged-cleanup`. Installation does not adopt the row. Preserve unknown historical evidence as original bytes; never treat it as current verification/review or operational closure. The supported closure family is the retained official public 0.3.5 archive/installed runtime admission, producer-bound run@3 and writers@1 on supported POSIX hosts. Missing closure, operative issue-cli v1/v2 or unknown resources must remain refused.

Apply only the exact plan with authenticated personal-operator native relinquishment and distinct configured reviewer-App whole-plan native acceptance. `issue_worktree_transition_apply` requires explicit authority, the saved plan/plan ID and both native comment IDs. Use the same inputs for interruption recovery. Pending and terminal-purpose intent blocks ordinary source mutations and re-registration. Active resume needs fresh current verification and review; original receipts retain their historical schema/accounting. Terminal disposition retains source/holds by default. Explicit unheld removal uses existing non-force cleanup; this skill grants no hold release, private adoption, launcher change, shared admission or legacy-protocol retirement authority.

## CLI fallback

```bash
ai-delivery --identity <configured-author> config:resolve
ai-delivery ready:check --issue <number>
ai-delivery develop --issue <number>
# edit, run focused checks, and commit in the prepared worktree
ai-delivery verify
```
