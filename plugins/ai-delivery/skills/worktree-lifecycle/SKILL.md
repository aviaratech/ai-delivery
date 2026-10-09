---
name: "ai-delivery:worktree-lifecycle"
description: Start a GitHub-linked issue branch, prepare a host-owned worktree and verify its change through repository contributor checks.
---

# Host-owned worktree lifecycle

Read user configuration and inspect `ai-delivery --repo <owner/name> config:resolve`. Confirm configured author and independent reviewer actors and repository access. Unknown GitHub rule visibility remains unknown.

Use `issue_info` and `issue_ready_check` with an explicit `repo`, then `issue_start` with the existing issue number to create or reuse its GitHub-linked branch. Prepare the local worktree using the host's supported worktree tools. Run the repository's own contributor checks, commit and push through its normal workflow. The ai-delivery runtime never executes repository policy modules or checks, or creates local worktrees. Continue to pull request handoff at the unchanged remote head.

```sh
ai-delivery --repo <owner/name> ready:check --issue <number>
ai-delivery --repo <owner/name> start --issue <number>
# Prepare a host-owned worktree, implement, run contributor checks, commit and push.
```

Parking an issue with `issue_update({repo, issueNumber, park: true})` retains its remote tracking presentation. Worktree cleanup remains with the host owner.

Legacy `issue_worktree_transition_inspect` and `issue_worktree_transition_apply` preserve their separate custody contract. Preserve original bytes and accounting; unsupported configuration or closure bindings fail closed. Apply only an exact independently accepted plan with native personal-operator relinquishment, distinct reviewer-App acceptance, complete immutable inventory, runtime admission and quiescent writer proof. This skill grants no private adoption, hold release, launcher change, shared admission or protocol retirement authority.

This runtime's CLI/MCP cannot reconstruct the historical repository-policy binding, so those transition commands refuse. Use the original controller for their successful execution; retained engine tests do not imply compatibility of the new public entrypoint.
