---
name: 'ai-delivery:intake-create'
description: Use ai-delivery MCP to read, list, search, create or update GitHub issues with an explicit repository from any directory. Apply to ordinary issue_info requests and issue intake validated by the ai-delivery.issue@1 contract.
---

# GitHub issue work

1. Discover requested installed MCP provider/schema; pass explicit `repo`. Prefixes aren't portable; remote calls need no checkout. Honor read-only/MCP-only/provider/“no other GitHub tool” restrictions. Missing/incompatible providers stop; no tool/actor/credential/permission/config substitution. CLI fallback requires unavailable MCP and permitted restrictions. Tools grant no authority; never evade refusals.

2. Reads use requested `issue_info`/`issue_list`/`issue_search` only. Before authorized updates inspect full native issue/metadata/relationships; use configured author, not Git identity. Preserve requirements/history; exclude secrets.

3. Typed intake requires problem/outcome, `behavior`/`verifiedBy`, non-goals, resolved questions/portable context, edge behavior and Bug regression/steps/expected/actual/reproducibility/environment. Native Type/Points: configured 1–8; split13. Blocked/tracking parents cannot autonomously start.

4. Ready defaults; Draft requires explicitly parked incomplete work and secret checks. Inspect warnings; fix blocking `code`/`field`/`fixHint`. Read `issue_info`/`issue_ready_check` before `issue_start`. [Schemas](https://github.com/aviaratech/ai-delivery/blob/main/src/mcp/tools.ts)/[status fields](https://github.com/aviaratech/ai-delivery/blob/main/src/issueContract.ts), drafts/publication prove neither readiness/review/merge/adoption.

5. Preserve [status/history/legacy retention](https://github.com/aviaratech/ai-delivery/blob/main/src/issue.ts); display blockers aren't native edges; status-only edits preserve other bytes. Validation rejects without writes. Reconcile partial/uncertain writes through native readback before retry; never duplicate creation.

6. Batches: 1–50 complete same-repository updates; dry runs write nothing. Inspect ordered results. Reconcile partial/unavailable state; resume skips satisfied outcomes/reuses comments. Rate exhaustion stops remaining writes. No transaction/rollback/automatic replay. CLI `--fields-file`: same patch; explicit flags override, omitted preserve.

Read example:

```json
{"repo":"example/widget","issueNumber":17}
```

Ready `/owned/issue.json`:

```json
{"title":"Reject invalid widget identifiers before persistence","issueType":"Task","points":2,"problem":"Malformed identifiers currently reach widget persistence.","outcome":"Reject malformed identifiers before persistence.","acceptanceCriteria":[{"behavior":"Invalid identifiers cause no persistence call.","verifiedBy":"Synthetic invalid-ID fixture asserts zero persistence calls."}],"outOfScope":["Changing storage."],"openQuestions":[],"context":{"components":["widget intake"],"files":["src/widget.ts"],"evidence":["Portable synthetic invalid-identifier fixture."]},"draft":false}
```

```sh
ai-delivery --identity host-author --repo example/widget create --title 'Reject invalid widget identifiers before persistence' --fields-file /owned/issue.json
```

Canonical marker: `<!-- ai-delivery:issue@1 -->`.
