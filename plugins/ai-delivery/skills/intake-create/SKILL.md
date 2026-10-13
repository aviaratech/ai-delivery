---
name: 'ai-delivery:intake-create'
description: Use ai-delivery MCP to read, list, search, create or update GitHub issues with an explicit repository from any directory. Apply to ordinary issue_info requests and issue intake validated by the ai-delivery.issue@1 contract.
---

# GitHub issue work

## Read first through the requested MCP provider

For an ordinary request such as “Use the ai-delivery MCP issue_info tool to read owner/name issue N,” discover the intended installed ai-delivery provider, inspect the tool schema, and pass the user's repository as `repo`. Ordinary remote issue/PR tools work from a non-Git directory when `repo` is explicit. Do not ask the user to move into a checkout for a remote read.

In Claude Code, when both bare and plugin-qualified ai-delivery tools are listed, select the installed plugin's compatible tool before calling. The observed Claude example is `mcp__plugin_ai-delivery_ai-delivery__issue_info`, with required `issueNumber` and optional `repo`. Other hosts may expose a different qualified name: use the discovered provider and schema rather than hardcoding Claude's prefix everywhere. A tool with only `issueNumber`/`cached` and no `repo` has a different contract; do not send it an unsupported repository field or assume its origin from its name.

For example, a fictional remote read takes this MCP argument object:

```json
{"repo": "example/widget", "issueNumber": 17}
```

Use the repository and issue actually requested. Reading needs no typed intake fields, readiness check or start action. A read-only request stays read-only: call `issue_info` for that read, or the requested `issue_list`/`issue_search` for finding work, without `issue_create`, `issue_update` or `issue_start`. Honor an explicitly selected provider and any “MCP only” or “no other GitHub tool” constraint. If the requested compatible provider is unavailable or its schema differs, report that limitation and stop; do not silently use another provider/CLI or change registrations, permissions, actors, credentials or host configuration.

## Issue intake and authorized updates

Use the complete native GitHub issue and its live relationships as the current contract. Select the intended repository explicitly and use its configured author identity; Git commit authors are not authentication. Inspect the current title, body, Issue Type, Points, Project status, parent and blockers before updating an existing issue. Preserve every agreed requirement and original history when correcting intake.

Gather the concrete problem, intended outcome, affected components/files, and portable evidence. Write each acceptance criterion as `behavior` plus `verifiedBy`: observable input/result plus the proof that establishes it. Include failure or edge behavior, and a regression test for a Bug. State at least one non-goal. Resolve `openQuestions` before proceeding. For Bugs gather ordered steps, expected and actual results, reproducibility and environment. Keep credentials and private keys out of every public field.

Choose native Points from the configured values within 1–8. Split a 13-point issue into executable children. Native Issue Type and Points remain authoritative; changing relationships must preserve the intended endpoints and native Project tracking. Tracking parents and issues with open blockers cannot start autonomously.

## Typed MCP workflow

1. Call `issue_create` or `issue_update` with typed problem/outcome/acceptanceCriteria/outOfScope/openQuestions/context/bug fields, title, configured Issue Type and Points. Ready is the default. Each blocking diagnostic includes `code`, `field`, and `fixHint`: fix every reported field and retry only the rejected write. Do not retry an uncertain native mutation without authoritative readback.
2. Use `draft: true` only for explicitly parked, incomplete work. It produces a Draft status; resolve fields and set `draft: false` to resume Ready intake. Drafts still reject secrets. Existing `park` also retains execution as a draft.
3. Inspect the native readback and warnings. More than seven criteria, absent edge/regression/context, only machine-local evidence or a body over about 3,000 characters warn without blocking. Consider a smaller scope or better proof.
4. Read `issue_info` and `issue_ready_check` before `issue_start`. Readiness validates the typed contract and live Points/blockers/tracking/draft state, without local path checks or a runnable-command requirement. Mentioning the Project Todo column is ordinary prose; unresolved decisions belong in `openQuestions`.
5. Bodies use `<!-- ai-delivery:issue@1 -->` with a generated Status block and canonical field data. Update typed fields rather than editing only one generated copy. Legacy handwritten bodies convert leniently on update, preserving the complete original in history and the body, and returning the prior/canonical body diff. Missing proof is reported, never invented. Review that diff and exact native readback.

The Draft/Ready structural JSON Schemas ship on the existing exported `AI_DELIVERY_MCP_TOOLS` issue-create definition as `issueContract`. Zod runtime validation also enforces semantic refinements (specific wording, bug evidence and secrets); portable structural JSON Schema alone does not prove readiness.

## Worked example

Save this UTF-8 typed field object as `/owned/issue.json` in your task-owned directory:

```json
{
  "title": "Reject invalid widget identifiers before persistence",
  "issueType": "Task",
  "points": 2,
  "problem": "Malformed identifiers currently reach widget persistence.",
  "outcome": "Reject malformed identifiers before any persistence call.",
  "acceptanceCriteria": [
    {
      "behavior": "An invalid identifier returns a typed error without a persistence call.",
      "verifiedBy": "A synthetic persistence regression asserts the error and zero calls."
    }
  ],
  "outOfScope": ["Changing the storage engine."],
  "openQuestions": [],
  "context": {
    "components": ["widget intake"],
    "files": ["src/widget.ts"],
    "evidence": ["A portable synthetic malformed identifier fixture."]
  },
  "draft": false
}
```

## CLI fallback

Use the installed CLI when MCP is unavailable only if the user's requested tool/provider restrictions permit that fallback. An MCP-only request, “no other GitHub tool,” or unavailable/incompatible requested-provider stop above does not authorize CLI substitution. Substitute your configured author identity, intended repository, owned JSON path and actual issue number. Explicit CLI values override the corresponding field-file values; omitted flags preserve them. `--fields-file` accepts the same typed field patch used by MCP. These commands perform real native operations only under your already authorized lifecycle:

```bash
ai-delivery --identity host-author --repo example/widget create --title 'Reject invalid widget identifiers before persistence' --fields-file /owned/issue.json
ai-delivery --identity host-author --repo example/widget info --issue 17
ai-delivery --identity host-author --repo example/widget update --issue 17 --fields-file /owned/issue.json --preserve-history
ai-delivery --identity host-author --repo example/widget ready:check --issue 17
ai-delivery --identity host-author --repo example/widget start --issue 17
```

A rejected validation writes nothing. A partial creation reports the already-created native issue; reconcile it and resume that issue rather than creating another. Do not treat a structural pass, directory publication, or draft state as independent review, merged delivery or native consumer adoption.
