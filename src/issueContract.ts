import { z } from 'zod';
import { DeliveryError } from './errors.js';

export const ISSUE_CONTRACT_VERSION = 'ai-delivery.issue@1' as const;
export const ISSUE_BODY_MARKER = '<!-- ai-delivery:issue@1 -->';
const DATA_PREFIX = '<!-- ai-delivery:issue-data@1 ';
const START_FOOTER =
  /\n\n<!-- ai-delivery-start-intent: sha256:[a-f0-9]{64} -->\n<!-- ai-delivery-start: sha256:[a-f0-9]{64} -->$/u;
export function issueStartFooter(body: string): string {
  return START_FOOTER.exec(body)?.[0] ?? '';
}
const Text = z.string();
const Strings = z.array(Text);
const AcceptanceCriterion = z.strictObject({ behavior: Text, verifiedBy: Text });

/** Drafts permit incomplete requirements, but never secret-bearing public content. */
export const IssueFields = z.strictObject({
  title: Text,
  issueType: Text.optional(),
  points: z.number().int().optional(),
  problem: Text.default(''),
  outcome: Text.default(''),
  acceptanceCriteria: z.array(AcceptanceCriterion).default([]),
  outOfScope: Strings.default([]),
  openQuestions: Strings.default([]),
  context: z
    .strictObject({ components: Strings.default([]), files: Strings.default([]), evidence: Strings.default([]) })
    .default({ components: [], files: [], evidence: [] }),
  bug: z
    .strictObject({ steps: Strings, expected: Text, actual: Text, reproducibility: Text, environment: Text })
    .optional(),
  draft: z.boolean().default(false),
  legacyBody: Text.optional(),
  retainLegacyBody: z.boolean().optional(),
});

const StatusText = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/u.test(value), 'Use one status line.');
export const CreateIssueStatus = z.strictObject({ nextMilestone: StatusText.optional() });
export const IssueStatusPatch = CreateIssueStatus.extend({
  blockers: StatusText.optional(),
  latestJournal: StatusText.optional(),
});
const IssueStatus = z.strictObject({
  state: z.enum(['Ready', 'Draft']),
  lastUpdated: z.iso.datetime(),
  nextMilestone: StatusText,
  blockers: StatusText,
  latestJournal: StatusText,
});
export type IssueStatusData = z.infer<typeof IssueStatus>;

export function requireIssueStatus<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new IssueValidationError(issueDiagnostics(result.error.issues));
  if (secrets(result.data))
    throw new IssueValidationError([
      hint('secrets', 'status', 'Remove credentials and private keys from public status fields.'),
    ]);
  return result.data;
}

export interface IssueDiagnostic {
  code: string;
  field: string;
  fixHint: string;
  message: string;
}
const hint = (code: string, field: string, fixHint: string): IssueDiagnostic => ({
  code,
  field,
  fixHint,
  message: fixHint,
});

function secrets(value: unknown): boolean {
  const strings = (item: unknown): string[] =>
    typeof item === 'string'
      ? [item]
      : Array.isArray(item)
        ? item.flatMap(strings)
        : item !== null && typeof item === 'object'
          ? Object.values(item).flatMap(strings)
          : [];
  const text = strings(value).join('\n');
  return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?(?!<|\$|redacted\b|placeholder\b)[A-Za-z0-9_+/-]{8,})/iu.test(
    text,
  );
}

function secretRule(value: z.output<typeof IssueFields>, ctx: z.RefinementCtx): void {
  if (secrets(value))
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: 'Remove credentials and private keys from public issue fields.',
      params: { issueCode: 'secrets' },
    });
}

export const DraftIssue = IssueFields.superRefine(secretRule);
export type DraftIssueData = z.output<typeof DraftIssue>;
export type IssueFieldsInput = z.input<typeof IssueFields>;

function readyRules(value: DraftIssueData, ctx: z.RefinementCtx): void {
  const add = (code: string, field: (string | number)[], fixHint: string): void =>
    ctx.addIssue({ code: 'custom', path: field, message: fixHint, params: { issueCode: code } });
  if (value.draft) add('draft', ['draft'], 'Resolve the draft fields and set draft to false before starting work.');
  if (value.points === undefined || value.points < 1 || value.points > 8)
    add('points', ['points'], 'Choose Points from 1 through 8; split a 13-point issue into sub-issues.');
  if (
    value.title.trim().length < 10 ||
    !/[\p{L}]/u.test(value.title) ||
    /^(?:fix|bug|task|feature|update|improve|test|issue|work)(?:\s+(?:it|this|stuff|things|issue))?[.!]?$/iu.test(
      value.title.trim(),
    )
  )
    add('title.specific', ['title'], 'Name the specific behavior or component that changes.');
  if (value.title.length > 80) add('title.length', ['title'], 'Shorten the title to at most 80 characters.');
  if (/^\s*(?:\[\s*(?:bug|feature|task)\s*\]|(?:bug|feature|task)\s*:)/iu.test(value.title))
    add('title.prefix', ['title'], 'Remove the issue-type prefix; use the native Issue Type field.');
  for (const field of ['problem', 'outcome'] as const)
    if (!value[field].trim()) add(field, [field], `Describe the ${field} in concrete terms.`);
  if (!value.acceptanceCriteria.length)
    add('acceptance-criteria', ['acceptanceCriteria'], 'Add an observable behavior and how it will be verified.');
  value.acceptanceCriteria.forEach((ac, index) => {
    if (!ac.behavior.trim() || !ac.verifiedBy.trim())
      add(
        'acceptance-criteria.fields',
        ['acceptanceCriteria', index],
        'Provide both behavior and verifiedBy for this criterion.',
      );
    if (
      /^(?:.{1,100}\s)?(?:works(?:\s+(?:correctly|as expected|well|properly))?|(?:is|are)\s+(?:done|verified|reviewed|robust|seamless|appropriate|user[- ]friendly))[\s.!]*$/iu.test(
        ac.behavior,
      ) ||
      ac.behavior.trim().length < 12
    )
      add(
        'acceptance-criteria.vague',
        ['acceptanceCriteria', index, 'behavior'],
        'Replace vague wording with an observable input and result.',
      );
  });
  if (!value.outOfScope.some((item) => item.trim()))
    add('out-of-scope', ['outOfScope'], 'Name at least one explicit non-goal.');
  if (value.openQuestions.length)
    add('open-questions', ['openQuestions'], 'Resolve each open question before marking the issue Ready.');
  if (value.issueType?.toLowerCase() === 'bug') {
    if (!value.bug)
      add('bug', ['bug'], 'Include steps, expected and actual results, reproducibility, and environment.');
    else {
      if (!value.bug.steps.length || value.bug.steps.some((step) => !step.trim()))
        add('bug.steps', ['bug', 'steps'], 'Provide nonempty ordered reproduction steps.');
      for (const field of ['expected', 'actual', 'reproducibility', 'environment'] as const)
        if (!value.bug[field].trim()) add(`bug.${field}`, ['bug', field], `Describe the bug's ${field}.`);
    }
  }
}

export const ReadyIssue = IssueFields.extend({
  title: Text.min(10).max(80),
  points: z.number().int().min(1).max(8),
  problem: Text.min(1),
  outcome: Text.min(1),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  outOfScope: Strings.min(1),
  openQuestions: Strings.max(0).default([]),
  draft: z.literal(false).default(false),
})
  .superRefine(secretRule)
  .superRefine(readyRules);
export type ReadyIssueData = z.output<typeof ReadyIssue>;
const ReadySemantics = IssueFields.superRefine(secretRule).superRefine(readyRules);
/** Portable structural schemas; semantic refinements are enforced by the write/readiness boundary. */
export const ISSUE_JSON_SCHEMAS = {
  version: ISSUE_CONTRACT_VERSION,
  draft: z.toJSONSchema(DraftIssue),
  ready: z.toJSONSchema(ReadyIssue),
};

/** Patch fields share the canonical validators but deliberately have no defaults. */
export const IssueWriteFields = {
  title: IssueFields.shape.title.optional(),
  issueType: IssueFields.shape.issueType,
  points: IssueFields.shape.points,
  problem: IssueFields.shape.problem.removeDefault().optional(),
  outcome: IssueFields.shape.outcome.removeDefault().optional(),
  acceptanceCriteria: IssueFields.shape.acceptanceCriteria.removeDefault().optional(),
  outOfScope: IssueFields.shape.outOfScope.removeDefault().optional(),
  openQuestions: IssueFields.shape.openQuestions.removeDefault().optional(),
  context: IssueFields.shape.context.removeDefault().optional(),
  bug: IssueFields.shape.bug,
  draft: IssueFields.shape.draft.removeDefault().optional(),
  retainLegacyBody: IssueFields.shape.retainLegacyBody,
};
export const IssueWriteSchema = z.strictObject(IssueWriteFields);

/** Keep advertised structural schemas while returning domain diagnostics before SDK error wrapping. */
export function issueInputSchema<T extends z.ZodObject>(schema: T): T {
  return schema.refine(() => true, {
    when: ({ issues }) => {
      // Parsed values have already lost unknown keys. Preserve the original structural failures.
      if (issues.length) throw new IssueValidationError(issueDiagnostics(issues));
      return true;
    },
  });
}

function issueDiagnostics(issues: readonly (z.core.$ZodIssue | z.core.$ZodRawIssue)[]): IssueDiagnostic[] {
  const seen = new Set<string>();
  return issues
    .map((issue) => {
      const field = (issue.path ?? []).map(String).join('.') || 'issue';
      const code =
        issue.code === 'custom' && typeof issue.params?.issueCode === 'string'
          ? issue.params.issueCode
          : field === 'points'
            ? 'points'
            : field === 'title'
              ? 'title.length'
              : field === 'outOfScope'
                ? 'out-of-scope'
                : field === 'openQuestions'
                  ? 'open-questions'
                  : field === 'acceptanceCriteria'
                    ? 'acceptance-criteria'
                    : field === 'draft'
                      ? 'draft'
                      : issue.code === 'unrecognized_keys'
                        ? 'field.unknown'
                        : 'field.type';
      return hint(
        code,
        field,
        code === 'points'
          ? 'Choose Points from 1 through 8; split a 13-point issue into sub-issues.'
          : issue.code === 'unrecognized_keys'
            ? 'Remove unrecognized fields from ' + field + '.'
            : (issue.message ??
              (issue.code === 'invalid_type'
                ? 'Provide a valid ' + issue.expected + ' value.'
                : 'Provide a value satisfying the declared issue field schema.')),
      );
    })
    .filter((issue) => {
      const key = issue.code + ':' + issue.field;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function validateIssue(value: unknown, ready = true): { issue?: DraftIssueData; failures: IssueDiagnostic[] } {
  const parsed = (ready ? ReadyIssue : DraftIssue).safeParse(value);
  if (parsed.success) return { issue: parsed.data, failures: [] };
  const semantic = ready ? ReadySemantics.safeParse(value) : undefined;
  const issues = [...(semantic?.success === false ? semantic.error.issues : []), ...parsed.error.issues];
  return { failures: issueDiagnostics(issues) };
}

export class IssueValidationError extends DeliveryError {
  constructor(readonly failures: IssueDiagnostic[]) {
    super(JSON.stringify({ contract: ISSUE_CONTRACT_VERSION, failures }));
  }
}

export function requireIssue(value: unknown): DraftIssueData {
  const structural = IssueFields.safeParse(value);
  const result = validateIssue(value, !structural.success || !structural.data.draft);
  if (!result.issue) throw new IssueValidationError(result.failures);
  return result.issue;
}

const escapeStatus = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_[\]]/gu, '\\$&');
const unescapeStatus = (value: string): string =>
  value
    .replace(/\\([\\`*_[\]])/gu, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

export function renderIssueBody(value: DraftIssueData, status?: IssueStatusData, legacyFormatting = false): string {
  const item = DraftIssue.parse(value);
  if (status !== undefined) requireIssueStatus(IssueStatus, status);
  const list = (values: string[]): string => (values.length ? values.map((v) => `- ${v}`).join('\n') : '(none)');
  const parts = [
    ISSUE_BODY_MARKER,
    '## Status',
    status === undefined
      ? item.draft
        ? 'Draft — parked; not ready to work.'
        : 'Ready'
      : `- **State:** ${status.state}\n- **Last updated:** ${status.lastUpdated} UTC\n- **Next milestone:** ${escapeStatus(status.nextMilestone)}\n- **Blockers:** ${escapeStatus(status.blockers)}\n- **Latest journal:** ${escapeStatus(status.latestJournal)}`,
    '## Problem',
    item.problem,
    '## Outcome',
    item.outcome,
    '## Acceptance criteria',
    item.acceptanceCriteria
      .map((ac) =>
        legacyFormatting
          ? `- [ ] ${ac.behavior}\n  Verified by: ${ac.verifiedBy}`
          : `- [ ] ${ac.behavior.replace(/\n/gu, '\n  ')}${ac.behavior.includes('\n') ? '\n' : ''}\n  Verified by: ${ac.verifiedBy.replace(/\n/gu, '\n  ')}`,
      )
      .join('\n'),
    '## Out of scope',
    list(item.outOfScope),
    '## Open questions',
    list(item.openQuestions),
    '## Context',
    `Components:\n${list(item.context.components)}\n\nFiles:\n${list(item.context.files)}\n\nEvidence:\n${list(item.context.evidence)}`,
  ];
  if (item.bug)
    parts.push(
      '## Bug',
      `Steps:\n${list(item.bug.steps)}\n\nExpected: ${item.bug.expected}\n\nActual: ${item.bug.actual}\n\nReproducibility: ${item.bug.reproducibility}\n\nEnvironment: ${item.bug.environment}`,
    );
  if (item.legacyBody !== undefined && item.retainLegacyBody !== false)
    parts.push('## Preserved legacy body', item.legacyBody);
  // Escape comment delimiters without altering decoded data. Exact render equality detects human/payload divergence.
  parts.push(`${DATA_PREFIX}${JSON.stringify(item).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')} -->`);
  return parts.join('\n\n') + '\n';
}

function section(body: string, names: string[]): string {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    names.includes(
      line
        .replace(/^#{1,6}\s+/u, '')
        .trim()
        .toLowerCase(),
    ),
  );
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^#{1,6}\s/u.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** Lenient conversion retains every legacy byte, and never invents verification or bug evidence. */
export function parseIssueBody(
  body: string,
  metadata: { title: string; points?: number; issueType?: string },
): { issue: DraftIssueData; legacy: boolean; status?: IssueStatusData; legacyFormatting?: boolean } {
  if (body.trimStart().startsWith(ISSUE_BODY_MARKER)) {
    const start = body.lastIndexOf(DATA_PREFIX);
    const end = body.indexOf(' -->', start);
    if (start < 0 || end < 0)
      throw new IssueValidationError([
        hint('body.canonical', 'body', 'Restore the complete canonical issue data and generated body.'),
      ]);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body.slice(start + DATA_PREFIX.length, end));
    } catch {
      throw new IssueValidationError([hint('body.canonical', 'body', 'Restore valid canonical issue data.')]);
    }
    const result = validateIssue(decoded, false);
    if (!result.issue) throw new IssueValidationError(result.failures);
    const displayed = body.slice((ISSUE_BODY_MARKER + '\n\n## Status\n\n').length, body.indexOf('\n\n## Problem\n\n'));
    let status: IssueStatusData | undefined;
    if (displayed !== 'Ready' && displayed !== 'Draft — parked; not ready to work.') {
      const match =
        /^- \*\*State:\*\* (Ready|Draft)\n- \*\*Last updated:\*\* (\S+) UTC\n- \*\*Next milestone:\*\* ([^\r\n]+)\n- \*\*Blockers:\*\* ([^\r\n]+)\n- \*\*Latest journal:\*\* ([^\r\n]+)$/u.exec(
          displayed,
        );
      if (!match)
        throw new IssueValidationError([
          hint('body.canonical', 'status', 'Restore the complete unambiguous status block.'),
        ]);
      status = requireIssueStatus(IssueStatus, {
        state: match[1],
        lastUpdated: match[2],
        nextMilestone: unescapeStatus(match[3]!),
        blockers: unescapeStatus(match[4]!),
        latestJournal: unescapeStatus(match[5]!),
      });
      if (status.state !== (result.issue.draft ? 'Draft' : 'Ready'))
        throw new IssueValidationError([
          hint('body.canonical', 'status', 'Status state must agree with the typed draft field.'),
        ]);
    }
    const footer = issueStartFooter(body);
    const canonical = footer ? body.slice(0, -footer.length) : body;
    const legacyFormatting = renderIssueBody(result.issue, status) !== canonical;
    if (
      (legacyFormatting && renderIssueBody(result.issue, status, true) !== canonical) ||
      result.issue.title !== metadata.title
    )
      throw new IssueValidationError([
        hint('body.canonical', 'body', 'Update typed fields instead of editing only one copy of canonical content.'),
      ]);
    return {
      issue: result.issue,
      legacy: false,
      ...(status === undefined ? {} : { status }),
      ...(legacyFormatting ? { legacyFormatting: true } : {}),
    };
  }
  const verification = section(body, ['verification', 'validation', 'tests']);
  const acText = section(body, ['acceptance criteria', 'acceptance']);
  const acceptanceCriteria = acText.split(/\n(?=\s*[-*+]\s+\[[ xX]\])/u).flatMap((block) => {
    const match = /^\s*[-*+]\s+\[[ xX]\]\s+([\s\S]+)/u.exec(block);
    if (!match) return [];
    const [behavior = '', verifiedBy = verification] = match[1]!.split(/\n\s*(?:Verified by:|Verified by)\s*/iu);
    return [{ behavior: behavior.trim(), verifiedBy: verifiedBy.trim() }];
  });
  const items = (s: string): string[] =>
    s
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*[-*+]\s+/u, '').trim())
      .filter(Boolean);
  const scope = section(body, ['scope', 'context']);
  const bug =
    metadata.issueType?.toLowerCase() === 'bug'
      ? {
          steps: items(section(body, ['steps', 'steps to reproduce'])),
          expected: section(body, ['expected', 'expected results']),
          actual: section(body, ['actual', 'actual results']),
          reproducibility: section(body, ['reproducibility']),
          environment: section(body, ['environment']),
        }
      : undefined;
  const converted = validateIssue(
    {
      ...metadata,
      problem: section(body, ['problem']),
      outcome: section(body, ['outcome']),
      acceptanceCriteria,
      outOfScope: items(section(body, ['out of scope', 'non-goals'])),
      openQuestions: items(section(body, ['open questions'])),
      context: { components: [], files: scope ? [scope] : [], evidence: verification ? [verification] : [] },
      ...(bug === undefined ? {} : { bug }),
      draft: /^draft\b/iu.test(section(body, ['status'])),
      legacyBody: body,
    },
    false,
  );
  if (!converted.issue) throw new IssueValidationError(converted.failures);
  return { issue: converted.issue, legacy: true };
}

export function issueWarnings(
  issue: DraftIssueData,
  status?: IssueStatusData,
  legacyFormatting = false,
): IssueDiagnostic[] {
  const warnings: IssueDiagnostic[] = [];
  if (issue.acceptanceCriteria.length > 7)
    warnings.push(
      hint('many-criteria', 'acceptanceCriteria', 'Consider slicing more than seven criteria into smaller issues.'),
    );
  if (
    !issue.acceptanceCriteria.some((ac) =>
      /\b(?:edge|failure|fail|error|invalid|reject|refus|empty|missing|interrupt|timeout|boundary)/iu.test(ac.behavior),
    )
  )
    warnings.push(hint('edge-case', 'acceptanceCriteria', 'Describe an edge or failure case.'));
  if (
    issue.issueType?.toLowerCase() === 'bug' &&
    !issue.acceptanceCriteria.some((ac) => /regression/iu.test(ac.behavior + ' ' + ac.verifiedBy))
  )
    warnings.push(hint('bug.regression', 'acceptanceCriteria', 'Add a regression test criterion for the bug.'));
  if (![...issue.context.files, ...issue.context.components].some((item) => item.trim()))
    warnings.push(hint('context', 'context', 'Name relevant components or files.'));
  const proofs = [...issue.context.evidence, ...issue.acceptanceCriteria.map((ac) => ac.verifiedBy)];
  if (proofs.length && proofs.every((proof) => /^(?:\/|[A-Za-z]:\\|~\/)/u.test(proof.trim())))
    warnings.push(
      hint('local-evidence', 'context.evidence', 'Use portable evidence in addition to machine-local paths.'),
    );
  const body = renderIssueBody(issue, status, legacyFormatting);
  if (body.slice(0, body.lastIndexOf(DATA_PREFIX)).length > 4000)
    warnings.push(hint('body.length', 'body', 'Consider reducing a readable body over 4,000 characters.'));
  return warnings;
}

export function issueBodyDiff(before: string, after: string): string {
  return [
    '--- prior body',
    '+++ canonical body',
    ...before.split('\n').map((line) => '-' + line),
    ...after.split('\n').map((line) => '+' + line),
  ].join('\n');
}
