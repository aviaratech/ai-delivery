---
name: 'ai-delivery:worktree-lifecycle'
description: Start a GitHub-linked issue branch and prepare a host-owned worktree.
---

# Worktree lifecycle

Read the target repository's `AGENTS.md` and `CONTRIBUTING.md` before changing it.
Use `issue_info` and `issue_ready_check` with an explicit `repo`, then
`issue_start` to create or reuse the existing issue's GitHub-linked branch.

Prepare one isolated worktree with the host's supported tools. ai-delivery
manages GitHub state; the host owns local files, checks and cleanup.

Implement the smallest change and run the checks required by that repository.
Commit and push through the normal host workflow, then use the PR handoff skill.

If a call fails or its result is unclear, read the current issue and branch
state before retrying. Report refusals without changing actors or permissions.
Parking an issue preserves its remote tracking; clean up only your own local
resources.
