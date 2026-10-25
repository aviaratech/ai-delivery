# AGENTS.md: aviaratech/ai-delivery

ai-delivery is a small CLI, MCP server and plugin that does GitHub issue, PR,
review and merge work for our agents. GitHub is the source of truth, and this
tool is a thin, typed wrapper around it. Your personal policy (Safety and the
Engineering charter) applies. This file sets this repo's limits.

## What this tool is not

- **Not a ledger.** It calls GitHub and reports what GitHub says. It keeps no
  receipts, provenance chains, grants or custody records of its own, and it
  doesn't re-prove what GitHub enforces (required checks, review counts,
  branch rules).
- **Not an authority.** Authority comes from Paul and the host's permission
  system. Don't add flags, receipts or checks that try to prove who allowed
  an action.
- **Not a recovery engine.** If a call fails or times out, read the current
  state and report it. Add recovery code only for a failure that has
  actually happened, and link it.

## Budgets

| What | Budget | Today (Oct 24) |
|---|---|---|
| Non-test code in `src/` and `scripts/` | 15,000 lines | 35,135 |
| Test code | no more than the code it covers | 41,965 |
| `npm run checks` (full PR check) | 5 minutes | about 12 |
| README | 1,500 words | 10,614 |
| Each skill | 400 words | up to 1,425 |
| CONTRIBUTING | 300 words | 2,675 |

Until the code is back under budget, each PR must remove at least as much
non-test code as it adds. The exceptions are a bug fix and a feature Paul
asked for by name.

## How to change it

- Make the smallest change that fixes the issue. Prefer deleting a mode or
  flag over adding one.
- Keep one command per job. Keep no legacy mode unless a named consumer uses
  it, and name that consumer in the code.
- Test commands against recorded GitHub responses. Don't test internal
  plumbing or the wording of docs.
- An error is one sentence: what failed and what to do.
- `aviaratech/ai` pins a version, so ship ai-facing changes as a release.

## Stop and ask Paul

- Before adding a command, MCP tool or config field.
- Before changing how reviews or merges are authorized.
- When a fix won't fit the budget.
