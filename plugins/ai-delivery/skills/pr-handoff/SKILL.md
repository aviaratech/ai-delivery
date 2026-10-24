---
name: 'ai-delivery:pr-handoff'
description: Use when publishing, independently reviewing or merging a GitHub-linked ai-delivery change.
---

# Pull request handoff

**Required before mutations:** Read [authority/recovery](../../README.md#authority-and-recovery) and [independent review](../../README.md#independent-review). For partial delivery, also read the complete [nonclosing contract](../../README.md#nonclosing-pull-requests); its exact-grant and uncertain-attempt rules are mandatory.

Identify operation/side effects, canonical repo/issue/PR, branch, exact head/current base and configured author/reviewer. Preserve original human authority separately from communication, access, admission, review, counted approval and execution. Inspect original scope when needed; label relays honestly. Reuse verified authority without redundant approval. Flags, START and dry runs add no authority. Preserve holds/refusals; do not reroute denied actions or blindly retry uncertain writes.

Run repository-owned proportionate checks; record selection and omitted proof. Hosts own commits/pushes/worktrees. Dry-run `issue_pr_create` with explicit repo, issue and body; inspect actors/rules before authorized draft publication. New nonclosing publication additionally requires the concrete head/base/author/body grant and bounded reference action from the required contract. Do not infer removal authority or create replacement drafts.

Obtain independent exact-commit/tree/diff review. Submit the reviewer's completed artifact through `issue_pr_review`/`pr:review`, or its strict verdict through the compatible explicit-profile `review submit` route. Record actual model metadata honestly. Reconcile uncertain submission; verify exact review readback and required approval counts. A profile mismatch grants no configuration/credential workaround.

Promote unchanged source only within authority. Merge requires fresh current-base native eligibility, required green CI and reviewed SHA. Changed source requires refreshed checks/review. `finish` closes only complete issues; nonclosing delivery uses guarded `pr:merge` and keeps the issue OPEN. Hosts verify owned cleanup.
