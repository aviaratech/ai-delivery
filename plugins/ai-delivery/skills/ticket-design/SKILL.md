---
name: 'ai-delivery:ticket-design'
description: Use before a Ready issue_create, or when slicing a design into tickets, so a builder can finish the issue without asking. Mechanics and refusals live in ai-delivery:intake-create.
---

# Design a builder-ready issue

A builder who reads only the issue must finish without asking. Work in order.

1. **Start from the design.** Write each rule as an acceptance criterion with `behavior` and `verifiedBy`. Give each examples (input → expected), including one failure. An open question means a draft, not Ready.
2. **Extend, don't fork.** Name in `extends` the decision or owner the ticket extends. If it would add a second path beside an owner, fold it into that owner first. List each search for earlier work in `priorWork` with its finding, or "none found".
3. **Decide.** Record each choice a builder would ask about: shape, names, failure behavior, invariants.
4. **Surface.** List every path with its change and exact signatures, copied from merged code. The surface is closed: the builder asks before touching more.
5. **Fences.** Name the tempting neighbors and each shared file's owner.
6. **Proof.** List commands in run order, focused first.
7. **Size.** Over 5 points or 6 paths, split into tickets that merge in order (`blockedBy`). Keep the contract (outcome, surface, acceptance, proof, prior work) to 400 words.
8. **Evidence.** Put evidence on the issue as a comment or artifact link, never a local path.
9. **Tier.** Default to standard; frontier only for a new state machine, concurrency or recovery logic, risk semantics, or a refactor no parity check can prove.
10. **Type and Priority.** Set both; Priority goes in the `priority` argument. A Bug needs steps, expected, actual, reproducibility, environment and a regression criterion.
11. **Self-check.** Could a builder finish without asking or adding a second way to do something? Then create it; fix refusals by `code`. To capture an idea, pass `draft: true`.

Ready `/owned/issue.json`:

```json
{"title":"Reject malformed widget identifiers before persistence","issueType":"Task","points":2,"problem":"Malformed identifiers reach widget persistence.","outcome":"saveWidget refuses malformed identifiers and writes nothing.","builder":{"tier":"standard"},"extends":["src/widget.ts saveWidget (the one widget write path)"],"priorWork":["none found: closed issues 'widget id'"],"decisions":["Valid id: ^w-[0-9a-f]{8}$. Refuse with InvalidWidgetId; never trim or coerce."],"acceptanceCriteria":[{"behavior":"saveWidget rejects a malformed id before any store call","verifiedBy":"src/widget.test.ts","examples":[{"input":"id 'w-0a1b2c3d'","expected":"one store.put"},{"input":"id ' w-0A1B2C3D'","expected":"InvalidWidgetId, zero store calls","failure":true}]}],"surface":[{"path":"src/widget.ts","change":"edit","signatures":["export function saveWidget(store: Store, w: Widget): void"]}],"fences":["src/store.ts (storage owner)"],"proof":["npx vitest run src/widget.test.ts"],"outOfScope":["Migrating stored ids"],"openQuestions":[],"draft":false}
```

```sh
ai-delivery --identity host-author --repo example/widget create --title 'Reject malformed widget identifiers before persistence' --priority P2 --fields-file /owned/issue.json
```
