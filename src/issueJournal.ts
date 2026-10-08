import { isIP } from 'node:net';
import { z } from 'zod';

const Text = z.string().trim().min(1).max(10000);
const Summary = Text.max(500).refine((value) => !/[\r\n]/u.test(value), 'Summary must be one plain-language line.');
const Date = z.iso.date();
const Evidence = z.url({ protocol: /^https$/u }).refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  return (
    !url.username &&
    !url.password &&
    isIP(hostname) === 0 &&
    hostname.includes('.') &&
    hostname !== 'localhost' &&
    !hostname.endsWith('.localhost') &&
    !hostname.endsWith('.local')
  );
}, 'Evidence must be an HTTPS link with a public DNS hostname and no credentials or IP literal.');
const Common = {
  issueNumber: z.number().int().positive(),
  summary: Summary,
  status: Text,
  nextStep: Text,
  nextDate: Date.nullable(),
  keyNumbers: z.array(Text),
  evidence: z.array(Evidence),
  details: Text.optional(),
  lengthCap: z.number().int().min(600).max(10000).optional(),
};

const JournalVariants = z.discriminatedUnion('kind', [
  z.strictObject({ ...Common, kind: z.literal('start'), outcome: Text }),
  z.strictObject({
    ...Common,
    kind: z.literal('progress'),
    evidence: z.array(Evidence).min(1),
    done: z.array(Text).min(1),
    decisionNeeded: Text,
  }),
  z.strictObject({ ...Common, kind: z.literal('decision'), decision: Text, rationale: Text }),
  z.strictObject({ ...Common, kind: z.literal('blocker'), blocker: Text, resolution: Text }),
  z.strictObject({
    ...Common,
    kind: z.literal('closeout'),
    acceptance: z.array(z.strictObject({ criterion: Text, evidence: Evidence })).min(1),
    followUps: z.array(Text),
  }),
]);
export type JournalInput = z.infer<typeof JournalVariants>;
// MCP requires an object schema; the same variant validator enforces kind-specific fields.
export const JournalInputSchema = z
  .strictObject({
    ...Common,
    kind: z.enum(['start', 'progress', 'decision', 'blocker', 'closeout']),
    outcome: Text.optional(),
    done: z.array(Text).min(1).optional(),
    decisionNeeded: Text.optional(),
    decision: Text.optional(),
    rationale: Text.optional(),
    blocker: Text.optional(),
    resolution: Text.optional(),
    acceptance: z
      .array(z.strictObject({ criterion: Text, evidence: Evidence }))
      .min(1)
      .optional(),
    followUps: z.array(Text).optional(),
  })
  .superRefine((input, ctx) => {
    const parsed = JournalVariants.safeParse(input);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

export function renderJournal(raw: JournalInput, marker?: string): string {
  const input = JournalVariants.parse(raw);
  const sections = [`**Kind:** ${input.kind}. **Status:** ${input.status}`];
  switch (input.kind) {
    case 'start':
      sections.push(`**Outcome:** ${input.outcome}`);
      break;
    case 'progress':
      sections.push(
        `**Done since last:**\n${input.done.map((item) => `- ${item}`).join('\n')}`,
        `**Decision needed:** ${input.decisionNeeded}`,
      );
      break;
    case 'decision':
      sections.push(`**Decision:** ${input.decision}`, `**Rationale:** ${input.rationale}`);
      break;
    case 'blocker':
      sections.push(`**Blocker:** ${input.blocker}`, `**Resolution needed:** ${input.resolution}`);
      break;
    case 'closeout':
      sections.push(
        `**Acceptance evidence:**\n${input.acceptance.map((item) => `- ${item.criterion} — ${item.evidence}`).join('\n')}`,
        `**Follow-ups:** ${input.followUps.length ? input.followUps.join('; ') : 'None.'}`,
      );
      break;
  }
  sections.push(
    `**Key numbers:** ${input.keyNumbers.length ? input.keyNumbers.join('; ') : 'None reported.'}`,
    `**Next:** ${input.nextStep} (${input.nextDate ?? 'date not scheduled'}).`,
    `**Evidence:** ${input.evidence.length ? input.evidence.join(' · ') : 'None yet.'}`,
  );
  if (input.details) sections.push(input.details);
  let body = input.summary;
  let overflow = '';
  for (const section of sections) {
    if (overflow || body.length + section.length + 2 > (input.lengthCap ?? 1800)) overflow += `\n\n${section}`;
    else body += `\n\n${section}`;
  }
  if (overflow) body += `\n\n<details>\n<summary>Additional journal detail</summary>${overflow}\n\n</details>`;
  return marker === undefined ? body : `${body}\n\n${marker}`;
}

export function acceptanceCriteria(body: string): string[] {
  return journalSection(body, ['acceptance criteria'])
    .map(
      (line) =>
        line
          .trimStart()
          .match(/^[-*+]\s*\[[ xX]\][ \t](.*)$/u)?.[1]
          ?.trim() ?? '',
    )
    .filter(Boolean);
}

export function issueFollowUps(body: string): string[] {
  return journalSection(body, ['follow-ups', 'follow ups'])
    .map(
      (line) =>
        line
          .trimStart()
          .match(/^[-*+]\s*(?:\[[ xX]\][ \t])?(.*)$/u)?.[1]
          ?.trim() ?? '',
    )
    .filter(Boolean);
}

// Match readiness's ATX heading boundaries without changing its separate contract owner.
function journalSection(body: string, headings: string[]): string[] {
  const heading = (line: string) =>
    line
      .match(/^ {0,3}#{1,6}[ \t](.*)$/u)?.[1]
      ?.trim()
      .toLowerCase();
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => headings.includes(heading(line) ?? ''));
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (heading(line) !== undefined) break;
    section.push(line);
  }
  return section;
}
