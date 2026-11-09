---
name: 'ai-delivery:ticket-design'
description: Use before a Ready issue_create, or when slicing a design into tickets, so a builder can finish the issue without asking. Mechanics and refusals live in ai-delivery:intake-create.
---

# Design a builder-ready issue

A builder who reads only the issue must finish without asking. Work through these in order.

1. **Start from the design.** Write each rule as an acceptance criterion with `behavior` and `verifiedBy`. Give each one examples (input → expected), including one failure (late, empty, invalid, restart). An open question means a draft, not Ready.
2. **Extend, don't fork.** Name in `extends` the architecture decision or existing owner the ticket uses or extends. If the change would add a second path beside an existing engine or owner, redesign it or fold it into that owner first.
3. **Decide.** Record each choice a builder would otherwise ask about as a decision: shape, names, failure behavior, the invariant it implements.
4. **Surface.** List every path with its change and exact signatures, copied from merged code. The surface is closed: the builder stops and asks before touching anything else.
5. **Fences.** Name the tempting neighbors and each shared file's owner.
6. **Proof.** List commands in run order, focused first.
7. **Size.** Over 5 points or 6 paths, split into tickets that merge in order (`blockedBy`). Points run 1–8; 13 means split.
8. **Tier.** Default to standard. Use frontier only for a new state machine, concurrency or recovery logic, risk semantics, or a refactor no parity check can prove.
9. **Type and Priority.** Set both; Priority goes in the tool's `priority` argument. A Bug also needs steps, expected, actual, reproducibility, environment and a regression criterion.
10. **Self-check.** Could a builder finish without asking, and without adding a second way to do something that already exists? Then create it, and fix any refusal by its `code`. To capture an idea now, pass `draft: true`.

Ready `/owned/issue.json`:

```json
{"title":"Reject malformed widget identifiers before persistence","issueType":"Task","points":2,"problem":"Malformed identifiers reach widget persistence.","outcome":"saveWidget refuses malformed identifiers and writes nothing.","builder":{"tier":"standard"},"extends":["src/widget.ts saveWidget (the one widget write path)"],"decisions":["Valid id: ^w-[0-9a-f]{8}$. Refuse with InvalidWidgetId; never trim or coerce."],"acceptanceCriteria":[{"behavior":"saveWidget rejects a malformed id before any store call","verifiedBy":"src/widget.test.ts","examples":[{"input":"id 'w-0a1b2c3d'","expected":"one store.put"},{"input":"id ' w-0A1B2C3D'","expected":"InvalidWidgetId, zero store calls","failure":true}]}],"surface":[{"path":"src/widget.ts","change":"edit","signatures":["export function saveWidget(store: Store, w: Widget): void"]}],"fences":["src/store.ts (storage owner)"],"proof":["npx vitest run src/widget.test.ts"],"outOfScope":["Migrating stored ids"],"openQuestions":[],"draft":false}
```

```sh
ai-delivery --identity host-author --repo example/widget create --title 'Reject malformed widget identifiers before persistence' --priority P2 --fields-file /owned/issue.json
```
