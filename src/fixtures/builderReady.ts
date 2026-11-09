import { IssueFields } from '../issueContract.js';

/** The ADR example: a Ready issue with every builder-ready field, zero failures and zero warnings. */
export const builderReady = () =>
  IssueFields.parse({
    title: 'Reject malformed widget identifiers before persistence',
    issueType: 'Task',
    points: 2,
    problem: 'Malformed identifiers reach widget persistence.',
    outcome: 'saveWidget refuses malformed identifiers and writes nothing.',
    builder: { tier: 'standard' },
    extends: ['src/widget.ts saveWidget (the one widget write path)'],
    decisions: ['Valid id: ^w-[0-9a-f]{8}$. Refuse with InvalidWidgetId; never trim or coerce.'],
    acceptanceCriteria: [
      {
        behavior: 'saveWidget rejects a malformed id before any store call',
        verifiedBy: 'src/widget.test.ts',
        examples: [
          { input: "id 'w-0a1b2c3d'", expected: 'one store.put' },
          { input: "id ' w-0A1B2C3D'", expected: 'InvalidWidgetId, zero store calls', failure: true },
        ],
      },
    ],
    surface: [
      {
        path: 'src/widget.ts',
        change: 'edit',
        signatures: ['export function saveWidget(store: Store, w: Widget): void'],
      },
    ],
    fences: ['src/store.ts (storage owner)'],
    proof: ['npx vitest run src/widget.test.ts'],
    outOfScope: ['Migrating stored ids'],
    openQuestions: [],
    draft: false,
  });

type Example = { input: string; expected: string; failure?: true | undefined };

/** Overlay for tests whose own Ready issue needs the builder-ready structure at create or draft-to-Ready. */
export const withBuilder = <
  T extends { acceptanceCriteria: { behavior: string; verifiedBy: string; examples?: Example[] | undefined }[] },
>(
  issue: T,
) => ({
  ...issue,
  builder: { tier: 'standard' as const },
  extends: ['src/widget.ts saveWidget (the one widget write path)'],
  decisions: ['Refuse malformed input; never coerce it.'],
  surface: [{ path: 'src/widget.ts', change: 'edit' as const, signatures: ['export function saveWidget(): void'] }],
  fences: ['src/store.ts (storage owner)'],
  proof: ['npx vitest run src/widget.test.ts'],
  acceptanceCriteria: issue.acceptanceCriteria.map((ac, index) =>
    index === 0 && ac.examples === undefined
      ? {
          ...ac,
          examples: [
            { input: 'valid input', expected: 'stored once' },
            { input: 'invalid input', expected: 'refused, zero writes', failure: true as const },
          ],
        }
      : ac,
  ) as T['acceptanceCriteria'],
});
