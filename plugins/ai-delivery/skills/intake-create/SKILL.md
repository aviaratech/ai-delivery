---
name: 'ai-delivery:intake-create'
description: Use ai-delivery MCP to read, list, search, create or update GitHub issues with an explicit repository from any directory. Apply to ordinary issue_info requests and issue intake validated by the ai-delivery.issue@1 contract.
---

# GitHub issue work

1. Discover requested installed MCP provider; inspect its schema and pass explicit `repo`. Host prefixes aren't portable. Honor read-only, MCP-only and provider restrictions, including “no other GitHub tool”. Unavailable/incompatible requested providers stop: report without substituting tools, actors, credentials, permissions or configuration. If MCP is unavailable, use CLI only when restrictions permit. Remote calls need no checkout. Tools grant no authority; never evade refusals.

2. Reads use only requested `issue_info`, `issue_list` or `issue_search`, without intake/readiness/start writes. Before authorized updates inspect the complete native issue, metadata and relationships. Use the configured author, not Git identity; preserve requirements/history and exclude secrets.

3. Supply typed problem, outcome, `behavior`/`verifiedBy` acceptance, non-goals, resolved questions and portable context. Include edge behavior; Bugs require regression, steps, expected/actual results, reproducibility/environment. Native Issue Type/Points govern: choose configured 1–8, split 13; tracking parents/blocked issues cannot start autonomously.

4. Follow [schemas](https://github.com/aviaratech/ai-delivery/blob/main/src/mcp/tools.ts) and [status/history fields](https://github.com/aviaratech/ai-delivery/blob/main/src/issueContract.ts). Ready is default; Draft only explicitly parked incomplete work, still secret-checked. Inspect warnings; correct every blocking `code`/`field`/`fixHint`. Read `issue_info`/`issue_ready_check` before `issue_start`. Schemas, drafts and publication prove neither readiness, review, merge nor adoption.

5. Preserve [status/history/legacy retention](https://github.com/aviaratech/ai-delivery/blob/main/src/issue.ts) semantics: display blockers are not native edges; status-only edits preserve other bytes. Validation rejection writes nothing. Reconcile known/partial creations and uncertain writes through native readback before retry; never duplicate creation.

6. Batches contain 1–50 complete same-repository updates. Dry runs write nothing; inspect every ordered result. Reconcile partial/unavailable state; resume skips satisfied outcomes and reuses comments. Rate exhaustion stops remaining writes. No transaction, rollback or automatic replay. CLI `--fields-file` uses the same patch; explicit flags override supplied fields, omitted flags preserve them.
