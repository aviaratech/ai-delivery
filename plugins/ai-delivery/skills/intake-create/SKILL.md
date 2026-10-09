---
name: "ai-delivery:intake-create"
description: Create or inspect a GitHub tracking issue and check whether it is ready for development.
---

# Issue intake

Use the native GitHub issue as the source of truth for its details and relationships. Keep one current contract in its title and body: the problem and evidence, outcome, scope, concise necessary non-goals, acceptance criteria, and relevant verification. Each criterion should name a result an owner or reviewer can observe and the proof that will demonstrate it. A generic "done", "verified", or "reviewed" checkbox, or an unrelated executable command, is insufficient even when `issue_ready_check` reports ready. That check establishes structural readiness; the owner and reviewer still assess whether the criteria and proof establish the requested outcome.

When an authorized requirement changes, use `issue_update` to revise the current outcome, scope, criteria, and verification in place. Retire conflicting requirements from the active body, retain the reason for the change in native issue history or a comment, and update actual parent, child, or blocked-by relationships if the revision changes dependencies. Read the issue back before development to confirm the contract and relationships agree. Open a fresh ticket and owner context only when the objective has materially changed or inherited context obstructs delivery; age, commit count, and context compaction alone do not require replacement.

For example, suppose a synthetic CLI issue originally required JSON as the default status output. If the authorized requirement becomes opt-in JSON while the default stays text, replace the old criterion rather than append another one. The current issue could say:

```markdown
## Outcome
Add opt-in JSON status output while preserving the text default.

## Scope
- `src/cli.ts`
- `src/cli.test.ts`

## Acceptance Criteria
- [ ] `sample-cli status --format json` emits parseable JSON with a `state` field; a CLI test parses and asserts the field.
- [ ] `sample-cli status` still emits the documented text form; a CLI test asserts the default output.

## Verification
Run `npm test -- src/cli.test.ts` to check both commands.
```

The earlier default-JSON requirement remains in issue history, not in the active criteria. "Change is verified" and `node --version` would meet neither criterion's proof, regardless of a structural ready result.

## MCP tools first

1. Use `issue_create` to create one coherent tracking issue with the applicable native issue metadata and relationships.
2. Use `issue_info` to inspect a known issue and `issue_update` for authoritative metadata, relationship, or lifecycle changes.
3. Run `issue_ready_check` before development. Resolve any reported gaps in the issue before proceeding.
4. Continue with `issue_start` and an explicit repository when the issue is ready; prepare its worktree through the host.

## CLI fallback

When MCP is unavailable, use the installed `ai-delivery` command:

```bash
ai-delivery create
ai-delivery info --issue <number>
ai-delivery update --issue <number> --body-file <current-issue.md>
ai-delivery ready:check --issue <number>
ai-delivery develop --issue <number>
```
