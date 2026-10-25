---
name: "ai-delivery:pr-handoff"
description: Open a PR for a GitHub issue, get it independently reviewed through a reviewer App, and merge it.
---

# PR handoff

Use this after your change is committed and pushed on the issue branch. The
target repo's own rules (its `AGENTS.md` or `CONTRIBUTING.md`) decide which
checks run and whether review is required.

```sh
# Open the PR as a draft.
ai-delivery --repo <owner/name> pr:create --issue <n> --body-file pr-body.md

# The reviewer reads the exact head and diff, writes verdict.json, then submits it.
ai-delivery review submit --pr <pr> --head <sha> --identity <reviewer-profile> \
  --verdict verdict.json --repo <owner/name>

# Mark it ready, check it, and merge.
ai-delivery --repo <owner/name> pr:create --issue <n> --ready
ai-delivery --repo <owner/name> pr:checks --pr <pr>
ai-delivery --repo <owner/name> finish --issue <n> --pr <pr> --reviewed-head <sha>
```

## Rules

- **Review.** The builder never submits its own review. A separate reviewer
  agent writes the `ai-delivery.review-verdict@1` file, which holds:
  - the verdict, approve or request-changes;
  - its findings, each marked blocking or non-blocking.

  The reviewer submits that file itself.
- **New head.** If the head changes after review, the reviewer reviews the new
  head before merge.
- **Merging.** `finish` merges only when GitHub says the PR can merge at the
  reviewed head with its required checks green. If it refuses, fix the reason
  it gives. Don't merge another way.
- **Unclear results.** If a command times out or its result is unclear, run
  `pr:info` before retrying, so you don't create a duplicate.
- **Reviewer setup.** To check a reviewer App's setup without posting
  anything, run `ai-delivery review doctor --identity <profile>`.
- **Credentials.** Never print them.
- **Partial fixes.** For a fix that should leave the issue open, see the
  README's `--non-closing` notes. This is rare.
