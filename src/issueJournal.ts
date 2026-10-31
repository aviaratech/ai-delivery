import { isIP } from 'node:net';
import { z } from 'zod';

const Text = z.string().trim().min(1).max(10000);
const Summary = Text.max(500).refine((value) => !/[\r\n]/u.test(value), 'Summary must be one plain-language line.');
const Date = z.iso.date();
const EvidenceUrl = z.url({ protocol: /^https$/u }).refine((value) => {
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
const Evidence = EvidenceUrl.describe(
  'HTTPS link with a public DNS hostname, such as a GitHub URL; no IP, localhost or credentials.',
);
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
/** Publish the same kind requirements enforced by the canonical variant schemas. */
export const JOURNAL_SCHEMA_METADATA = {
  required: [
    ...Object.entries(Common)
      .filter(([, schema]) => !schema.isOptional())
      .map(([key]) => key),
    'kind',
  ],
  anyOf: JournalVariants.options.map((variant) => ({
    properties: { kind: { const: variant.shape.kind.value } },
    required: Object.entries(variant.shape as Record<string, z.ZodType>)
      .filter(([key, schema]) => !(key in Common) && key !== 'kind' && !schema.isOptional())
      .map(([key]) => key),
  })),
};
export function missingJournalFields(input: Record<string, unknown>): string[] {
  const variant = JournalVariants.options.find((option) => option.shape.kind.value === input.kind);
  const shape = variant?.shape ?? { ...Common, kind: z.string() };
  return Object.entries(shape as Record<string, z.ZodType>)
    .filter(([key, schema]) => !schema.isOptional() && input[key] === undefined)
    .map(([key]) => key);
}

// MCP requires an object schema; the same variant validator enforces kind-specific fields.
export const JournalInputSchema = z
  .strictObject({
    ...Common,
    kind: z
      .enum(['start', 'progress', 'decision', 'blocker', 'closeout'])
      .describe(
        'Select a journal kind and provide its required fields: start: outcome; progress: done, decisionNeeded and non-empty evidence; decision: decision and rationale; blocker: blocker and resolution; closeout: acceptance and followUps.',
      ),
    outcome: Text.optional(),
    done: z.array(Text).min(1).optional(),
    decisionNeeded: Text.optional(),
    decision: Text.optional().describe('Required non-empty text when kind is decision; omit for every other kind.'),
    rationale: Text.optional().describe('Required non-empty text when kind is decision; omit for every other kind.'),
    blocker: Text.optional(),
    resolution: Text.optional(),
    acceptance: z
      .array(
        z.strictObject(
          { criterion: Text, evidence: Evidence },
          { error: 'Invalid acceptance entry. Provide only criterion and evidence.' },
        ),
      )
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
  const plainPreview = (value: string): string => {
    const plain = value
      .replace(/!?\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gmu, '')
      .replace(/[*_~`<>[\]\\]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    const preview = plain.slice(0, 32);
    const last = preview.charCodeAt(preview.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? preview.slice(0, -1) : preview;
  };
  const field = (label: string, value: string): string =>
    `**${label}:**${/\n|^(?:[-*+]\s|\d+[.)]\s)/u.test(value) ? '\n' : ' '}${value}`;
  const list = (values: string[]): string => values.map((value) => '- ' + value.replace(/\n/gu, '\n  ')).join('\n');
  const sections = [`**Kind:** ${input.kind}. **Status:** ${input.status}`];
  switch (input.kind) {
    case 'start':
      sections.push(field('Outcome', input.outcome));
      break;
    case 'progress':
      sections.push(`**Done since last:**\n${list(input.done)}`, field('Decision needed', input.decisionNeeded));
      break;
    case 'decision':
      sections.push(field('Decision', input.decision), field('Rationale', input.rationale));
      break;
    case 'blocker':
      sections.push(field('Blocker', input.blocker), field('Resolution needed', input.resolution));
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
  let body = `Status: ${plainPreview(input.status)}. Next: ${plainPreview(input.nextStep)}.\n\n${input.summary}`;
  let overflow = '';
  for (const section of sections) {
    if (overflow || body.length + section.length + 2 > (input.lengthCap ?? 1800)) overflow += `\n\n${section}`;
    else body += `\n\n${section}`;
  }
  if (overflow) body += `\n\n<details>\n<summary>Additional journal detail</summary>${overflow}\n\n</details>`;
  return marker === undefined ? body : `${body}\n\n${marker}`;
}

export type JournalAttention = {
  kind: JournalInput['kind'] | null;
  state: 'pending' | 'clear' | 'unknown';
  request: string | null;
  reason: string | null;
};

/** Read only unambiguous structure emitted by renderJournal; free text is not a second template. */
export function parseJournalAttention(body: string): JournalAttention {
  const unknown = (): JournalAttention => ({
    kind: null,
    state: 'unknown',
    request: null,
    reason: 'Journal structure is incomplete or ambiguous.',
  });
  // Match the same UTF-16 unit bounds used by plainPreview.
  const preview = /^Status: ([^\r\n]{0,32})\. Next: ([^\r\n]{0,32})\.\n\n(?!\*\*Kind:\*\*)/.exec(body);
  if (preview && preview.slice(1).every((value) => value.length <= 32 && !/[*_~`<>[\]\\]|[^\S ]/u.test(value)))
    body = body.slice(preview[0].length);
  const markers = body.match(/<!--\s*ai-delivery:journal@/gu) ?? [];
  if (markers.length) {
    const suffix = /\n\n<!-- ai-delivery:journal@1:sha256:[a-f0-9]{64} -->$/u.exec(body);
    if (markers.length !== 1 || !suffix) return unknown();
    body = body.slice(0, suffix.index);
  }
  if (/<\/?details>|<\/?summary>/u.test(body)) {
    const opening = '\n\n<details>\n<summary>Additional journal detail</summary>';
    if (
      body.split('<details>').length !== 2 ||
      body.split('</details>').length !== 2 ||
      body.split('<summary>').length !== 2 ||
      body.split('</summary>').length !== 2 ||
      !body.includes(opening) ||
      !body.endsWith('\n\n</details>')
    )
      return unknown();
    body = body.replace(opening, '').slice(0, -'\n\n</details>'.length);
  }
  const kind = /\*\*Kind:\*\* (start|progress|decision|blocker|closeout)\. \*\*Status:\*\*/u.exec(body)?.[1] as
    | JournalInput['kind']
    | undefined;
  if (!kind) return unknown();
  const fields: Record<JournalInput['kind'], string[]> = {
    start: ['Outcome'],
    progress: ['Done since last', 'Decision needed'],
    decision: ['Decision', 'Rationale'],
    blocker: ['Blocker', 'Resolution needed'],
    closeout: ['Acceptance evidence', 'Follow-ups'],
  };
  const expected = ['Kind', 'Status', ...fields[kind], 'Key numbers', 'Next', 'Evidence'];
  const matches = [
    ...body.matchAll(
      /\*\*(Kind|Status|Outcome|Done since last|Decision needed|Decision|Rationale|Blocker|Resolution needed|Acceptance evidence|Follow-ups|Key numbers|Next|Evidence):\*\*/gu,
    ),
  ];
  if (matches.length !== expected.length || matches.some((match, i) => match[1] !== expected[i])) return unknown();
  const first = matches[0]!.index;
  if (!/^[^\r\n]+\n\n$/u.test(body.slice(0, first))) return unknown();
  let request: string | null = null;
  for (const [i, match] of matches.entries()) {
    if (i !== 1 && body.slice(match.index - 2, match.index) !== '\n\n') return unknown();
    let fence: string | null = null;
    for (const line of body.slice(0, match.index).split('\n')) {
      const edge = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (!edge) continue;
      if (fence === null) fence = edge[1]!;
      else if (edge[1]![0] === fence[0] && edge[1]!.length >= fence.length && !edge[2]!.trim()) fence = null;
    }
    if (fence !== null) return unknown();
    const end = matches[i + 1]?.index ?? body.length;
    const value = body.slice(match.index + match[0].length, end).trim();
    if (!value) return unknown();
    if (match[1] === 'Decision needed') request = value;
  }
  if (kind !== 'progress') return { kind, state: 'clear', request: null, reason: null };
  if (request === null) return unknown();
  return /^(?:none\.?|n\/a|not needed)$/iu.test(request)
    ? { kind, state: 'clear', request: null, reason: null }
    : { kind, state: 'pending', request, reason: null };
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
