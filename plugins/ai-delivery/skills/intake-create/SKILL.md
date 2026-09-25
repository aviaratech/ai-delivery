---
name: "ai-delivery:intake-create"
description: Create or inspect a GitHub tracking issue and check whether it is ready for development.
---

# Issue intake

Use the native GitHub issue as the source of truth for issue details and relationships. Keep the title and body concrete: describe the problem, available evidence, acceptance criteria, and verification command.

## MCP tools first

1. Use `issue_create` to create one coherent tracking issue with the applicable native issue metadata and relationships.
2. Use `issue_info` to inspect a known issue and `issue_update` for authoritative metadata, relationship, or lifecycle changes.
3. Run `issue_ready_check` before development. Resolve any reported gaps in the issue before proceeding.
4. Continue with `issue_develop` when the issue is ready.

## CLI fallback

When MCP is unavailable, use the installed `ai-delivery` command:

```bash
ai-delivery create
ai-delivery info --issue <number>
ai-delivery ready:check --issue <number>
ai-delivery develop --issue <number>
```
