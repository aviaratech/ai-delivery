# Recorded public GitHub fragments

Issue #189 adds explicitly synthetic `IssueComment` response replays for standing approvals. No live approval was created or consumed. `queueScenario` projects one shared fictional native comment collection through REST target-aware comments and GraphQL discovery/node reads. The fields follow the [native IssueComment schema](https://docs.github.com/en/graphql/reference/issues#issuecomment): node/author/repository/containing-PR identities, body, creation/update time, nullable edit/editor evidence and minimization. Missing fields remain missing; a null editor/edit timestamp is not reconstructed from REST timestamp equality.

`syntheticStandingApprovalRefusals` records the synthetic response mutations and expected reasons for non-approver, expired, same-second edit, missing edit evidence, unknown condition, duplicate PR, wrong repository, missing predecessor and minimized cases. Additional synthetic transitions cover complete/incomplete pagination, ambiguous grants, read failure redaction, absent configuration, later code changes with fresh native proof, revocation/expiry after a confirmed merge, removal/re-enqueue and acknowledged/absent/duplicate/spoofed/edited comment outcomes, including a same-second restored body with explicit native edit evidence. A controlled controller clock makes between-merge expiry independent of test runtime. Native comment IDs remain unique after deletion. These replays exercise the real queue/persistence/notification owners and inert Git transport; they do not claim an actual recorded standing approval, hosted queue-SHA qualification, installed capability or atomic GitHub comment/merge race.

Issue #188's queue tests reuse the observed `reviewDecision: null` value below. Its non-draft eligibility, queue-SHA checks, ordered squashes, owner refresh/`BEHIND` transitions, head/base drift, conflict, failed check, cancellation and lost acknowledgements are explicitly synthetic. `queueScenario` uses real owned Git objects and the actual bounded process runner, substituting only remote transport, GitHub HTTP and selected-author credentials. These cases neither qualify a hosted queue-SHA workflow nor establish a production outside-writer race.

The original public projections below support issue #167's approved four-file design. On October 21,
2026, the operator explicitly accepted recorded public fragments plus labeled
synthetic transitions. They characterize the existing native GitHub eligibility
and exact-artifact submission contracts; they introduce no merge policy or
automatic reapproval feature.

## Provenance

The TypeScript constants are field projections of retained response bodies.
SHA256 below identifies each original retained file, before projection. The
fixtures require no original local files, credentials or live network access.
`data` is removed where the existing GraphQL client's return value already
unwraps that envelope. No null, absent field, boolean, SHA, enum case, review ID
or retained array is normalized. Fields outside each projection are omitted
deliberately; absence of those fields is not evidence of their original absence.

| Source                                                                                                       | Retained filename                                      | Original SHA256                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| [PR55](https://github.com/aviaratech/ai-memory/pull/55), native null/count0/draft                            | `host-client-pr55-review-protection-native-access.log` | `fb645dc976026c31f1fdae9880bd313f3da89869682ee7be90c6fbe9c4b3dd04` |
| [PR154](https://github.com/aviaratech/ai-delivery/pull/154), before base drift                               | `approved-merge-native-preflight.json`                 | `45603e5265436501ff69a5361fe67cde8b59df80ead528626f40835478c30ea9` |
| PR154, same-head main drift                                                                                  | `after148-native-drift.json`                           | `c70eae1e2b586d55600e9a1125cfdb44041d44b09f3119b863712546c309c468` |
| [Remapped review5607142466](https://github.com/aviaratech/ai-delivery/pull/154#pullrequestreview-5607142466) | `remote-reviews.stdout`                                | `8d252cdef5227feee72b79b3180915b15e915ca6d31d7195db2c321af2f976c8` |
| [Fresh review5607508810](https://github.com/aviaratech/ai-delivery/pull/154#pullrequestreview-5607508810)    | `after-app-reviews.stdout`                             | `7c59ee4dc0738af839033c0e6abe3ef3fbb188dcf45f6887f89e13e6b6ad3bd1` |

PR55's capture used `gh api graphql`, selecting repository
`aviaratech/ai-memory`, `pullRequest(number:55)` (head/base/state/isDraft,
reviewDecision/reviews and baseRef.branchProtectionRule), plus viewer metadata
omitted here. The original command/output pins survive. Exact capture time is
unknown; the owning proposal's observation time is 2026-10-20T23:09:21Z.
An independently pinned earlier GraphQL output,
`host-client-pr55-native-review-readback.log`, SHA256
`8b6f233d2dcb1257e09adf95a38eb391c3944904bbb9f0e510db36d6c35bfb8d`,
also records draft/null/count0. The derived checkpoint is not a raw recording.

The two earlier PR154 base snapshots retain GraphQL response envelopes in the
owning `readiness-20261021T185605Z` evidence. Their exact capture commands/times
are unknown; the directory label is not a per-response timestamp. Review
recordings used `gh api repos/aviaratech/ai-delivery/pulls/154/reviews --paginate
--slurp`, producing nested page arrays. Their verified producer windows are
2026-10-21T23:30:23.484Z–23:30:27.242Z and
2026-10-21T23:34:24.930Z–23:34:28.274Z. The constants select one record from each;
they do not claim to replay complete historical pagination.

## Observations and synthetic transitions

- PR55 is actually OPEN, **draft true**, with observed `reviewDecision: null`
  and approval count zero on its base rule. Mergeability/checks are absent.
  The original pre-change REST protection response is missing: six of seven
  owning proposal pins survive, but derived complete-protection fields and
  exit-code logs cannot reconstruct it. Full effective ruleset completeness and
  an observed eligible-positive merge are unproved. The observed-draft test
  refuses. Positive finish/dry-run tests introduce synthetic ready/CLEAN and
  successful-check states, retaining the observed head/base/null fragment.
- PR154's before snapshot is CLEAN/MERGEABLE at head47cb/base3759/main3759.
  The after snapshot keeps head47cb/base3759 while main is d268; mergeability
  is UNKNOWN and `isDraft` is absent. No within-call race was recorded. Tests
  compose a synthetic ordering across the existing merge boundary. The UNKNOWN
  case refuses at eligibility; a separately labeled CLEAN transition reaches
  the final base-SHA guard. A new synthetic consistent candidate exercises retry.
- The historical review's REST commit SHA is current aec1b0c, while its embedded
  artifact binds old6534bdad/treeef6ac124. The later artifact binds current
  aec1b0c/tree2cd3b7f. IDs, URLs and head/tree discrepancy are retained. Unrelated
  review prose/identities/artifact fields are projected out. Tests generate new
  sanitized artifact bodies using synthetic roles, scope, summary and issue/PR
  aliases, and recompute their digests. These digests are never represented as
  the original artifact IDs. Historical review bodies remain unchanged on retry.
- Existing `example/widget` issue17/PR23 and `example/repo` issue17/PR19 are
  explicit synthetic aliases. Negative missing-decision, failed/missing-check,
  BLOCKED/BEHIND/DIRTY cases are synthetic mutations, not additional recordings.
  Native eligibility remains authoritative; no stricter local check predicate
  is inferred from a contradictory CLEAN response.

No credentials, authentication headers, machine paths, configuration or private
consumer data are included. Fixtures are public metadata projections, not whole
HTTP captures or proof of a production race. Tests assert real finish/merge and
review-submission behavior through the existing API boundary mocks: exact SHA,
PR/issue/artifact identity, request order, refusal before mutation, readback and
idempotent review retry. Requiring non-null approval, accepting a missing decision
as null, removing the final base guard, or reusing a remapped artifact would break
these regressions.
