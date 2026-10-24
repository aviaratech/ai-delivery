---
name: 'ai-delivery:intake-create'
description: Use when reading, listing, searching, creating or updating GitHub issues through ai-delivery with an explicit repository.
---

# GitHub issue work

**Required:** Read [tool discovery](../../README.md#issue-reads-and-tool-discovery) for reads; before writes, also read [issue contracts](../../README.md#issue-contracts) and [authority/recovery](../../README.md#authority-and-recovery).

For an ordinary read, discover the requested installed provider, inspect its schema and call `issue_info({repo: "owner/name", issueNumber})`. Explicit repositories work outside Git. Listing/searching uses the corresponding tool. Reads require no intake fields, readiness check, start or checkout. Honor provider/read-only/MCP-only restrictions. An unavailable or incompatible requested provider stops that read; do not substitute tools, repair registrations or change credentials.

For authorized intake, use the complete live issue and native relationships. Preserve original requirements/history. Supply typed problem, outcome, observable acceptance/proof, non-goals, resolved questions, configured Issue Type and Points; Bugs also need reproducible evidence and regression proof. Split oversized work. Keep secrets out of public fields.

Use `issue_create`/`issue_update` with explicit repo and the configured author. Fix returned field/code/fixHint diagnostics, then inspect native readback. Draft permits incomplete planning, not secrets. Read `issue_info` and `issue_ready_check` before `issue_start`; tracking parents/open blockers cannot start autonomously.

History/render retention, status-only byte preservation, dates, batches, deferrals and partial-write recovery follow the required contract reference. Dry runs write nothing. Reconcile uncertain or partial native writes before retry; reuse the known issue instead of creating a replacement. CLI fallback is permitted only when MCP is unavailable and the operator's provider restrictions allow it.
