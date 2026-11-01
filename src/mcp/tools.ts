import { z } from 'zod';
import { NativeIssueDateFields } from '../github/nativeIssueMetadata.js';
import { DeliveryHealthInput } from '../services/deliveryHealthService.js';
import { BoardReconcileInput } from '../services/boardReconcileService.js';
import { OverrideReason } from '../services/blockerGuardService.js';
import { JournalInputSchema, JOURNAL_SCHEMA_METADATA } from '../issueJournal.js';
import {
  IssueFields,
  IssueWriteFields,
  ISSUE_JSON_SCHEMAS,
  issueInputSchema,
  CreateIssueStatus,
  IssueStatusPatch,
  ProjectStatusPatch,
  IssueDeferralPatch,
} from '../issueContract.js';

const Verbose = z.boolean().optional().describe('Return the full payload, including bodies, diffs and routing.');
const Positive = z.number().int().positive();
const Labels = z.array(z.string().trim().min(1));
const REPO_HELP =
  'GitHub owner/name. Pass the repository named by the user. An explicit repo avoids launch-directory Git for ordinary remote issue/PR work; retained local modes keep their own checkout requirements.';
const Repo = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .optional()
  .describe(REPO_HELP);
export const AI_DELIVERY_MCP_CONTRACT_VERSION = 'ai-delivery.mcp@2' as const;
const IssueUpdateInput = issueInputSchema(
  z
    .strictObject({
      ...IssueWriteFields,
      ...NativeIssueDateFields,
      status: IssueStatusPatch.optional(),
      projectStatus: ProjectStatusPatch.optional(),
      repo: Repo,
      blockedBy: z.array(Positive).optional(),
      blocks: z.array(Positive).optional(),
      overrideReason: OverrideReason.optional(),
      body: z.string().optional(),
      issueNumber: Positive,
      issueType: IssueWriteFields.issueType,
      labels: Labels.optional(),
      milestone: Positive.nullable().optional(),
      parentIssueNumber: Positive.nullable().optional(),
      park: z.literal(true).optional(),
      ...IssueDeferralPatch,
      points: IssueWriteFields.points,
      priority: z.string().min(1).optional(),
      state: z.enum(['open', 'closed']).optional(),
      preserveHistory: z.boolean().optional(),
      closeReason: z.enum(['completed', 'not_planned', 'duplicate']).optional(),
      supersededBy: Positive.optional(),
      title: IssueWriteFields.title,
    })
    .superRefine((input, ctx) => {
      if (input.defer !== undefined && input.undefer !== undefined)
        ctx.addIssue({ code: 'custom', message: 'Choose defer or undefer, never both.', path: ['defer'] });
      if ((input.closeReason !== undefined || input.supersededBy !== undefined) && input.state !== 'closed')
        ctx.addIssue({
          code: 'custom',
          path: ['state'],
          message: 'Closure details require a closed issue; set state to closed.',
          params: { issueCode: 'closure.state' },
        });
    }),
);

const Tracking = {
  verbose: Verbose,
  blockedBy: z.array(Positive).optional(),
  blocks: z.array(Positive).optional(),
  overrideReason: OverrideReason.optional(),
  body: z.string().optional(),
  issueType: z.string().min(1).optional(),
  labels: Labels.optional(),
  milestone: Positive.optional(),
  parentIssueNumber: Positive.optional(),
  points: Positive.optional().describe(IssueFields.shape.points.description ?? ''),
  priority: z.string().min(1).optional(),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .optional()
    .describe(REPO_HELP),
  title: z
    .string()
    .trim()
    .min(1, 'Issue title is empty; enter a title.')
    .max(256, 'Issue title exceeds 256 characters; shorten the title.')
    .describe(IssueFields.shape.title.description ?? ''),
};
const NormalStart = z.strictObject({
  ...Tracking,
  title: Tracking.title.optional(),
  issueNumber: Positive.optional(),
  request: z.string().min(1).optional(),
  requestId: z.string().trim().min(1).max(256).optional(),
  resumeCreated: z.boolean().optional(),
  branch: z.string().min(1).optional(),
});
const IssueListing = {
  repo: Repo,
  verbose: Verbose,
  state: z.enum(['open', 'closed', 'all']).optional(),
  labels: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^[^"\\\r\n]+$/u),
    )
    .optional(),
  parentIssueNumber: Positive.nullable().optional(),
  issueType: z.string().min(1).optional(),
  projectStatus: z.enum(['Todo', 'In Progress', 'Blocked', 'Done']).nullable().optional(),
  updatedSince: z.iso.datetime({ offset: true }).optional(),
  page: Positive.optional(),
  perPage: Positive.max(100).optional(),
};
const SearchText = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^"\\\r\n]+$/u);

export const AI_DELIVERY_MCP_TOOLS = [
  {
    name: 'delivery_board',
    commandName: 'board',
    description:
      'Read human attention, native PR readiness, stale In Progress issues and seven-day delivery marker fractions for explicit repositories. Partial observations are data, never merge authority.',
    inputSchema: z.strictObject({
      repos: z.array(Repo.unwrap()).min(1),
      decisionLabels: z.array(z.string().min(1)).optional(),
      verbose: Verbose,
    }),
  },
  {
    name: 'board_reconcile',
    commandName: 'board:reconcile',
    description:
      'Plan or apply bounded Project membership and proven Status reconciliation for 1–10 explicit repositories. Retain the original plan and optional prior result for recovery; unknown activity and metadata suggestions never authorize writes.',
    inputSchema: BoardReconcileInput,
  },
  {
    name: 'delivery_health',
    commandName: 'health',
    description: 'Read bounded native delivery health for an explicit repository and UTC window',
    inputSchema: DeliveryHealthInput,
  },
  {
    name: 'issue_comment',
    commandName: 'comment',
    description:
      'Post a typed issue journal with authoritative comment readback. Provide the fields required by kind: start: outcome; progress: done, decisionNeeded and non-empty evidence; decision: non-empty decision and rationale; blocker: blocker and resolution; closeout: acceptance and followUps. Omit fields belonging to other kinds.',
    inputSchema: z
      .strictObject({ ...JournalInputSchema.shape, repo: Repo, verbose: Verbose })
      .superRefine(({ repo: _repo, verbose: _verbose, ...journal }, ctx) => {
        // Repository routing belongs to the MCP envelope, not the strict journal variants.
        const parsed = JournalInputSchema.safeParse(journal);
        if (!parsed.success)
          for (const issue of parsed.error.issues)
            ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      })
      .meta(JOURNAL_SCHEMA_METADATA),
  },
  {
    name: 'issue_create',
    commandName: 'create',
    description: 'Create a native GitHub tracking issue with configured metadata and relationships',
    issueContract: ISSUE_JSON_SCHEMAS,
    inputSchema: issueInputSchema(
      z.strictObject({
        ...Tracking,
        ...NativeIssueDateFields,
        ...IssueWriteFields,
        title: IssueFields.shape.title,
        opId: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .optional()
          .describe(
            'Stable retry identity: repeat the same original arguments to complete a partial create without another issue.',
          ),
        status: CreateIssueStatus.optional(),
      }),
    ),
  },
  {
    name: 'issue_start',
    commandName: 'start',
    description:
      'Start a linked issue. Prefer issueNumber of an open issue that already meets the ready contract: title, Points and, for Bug issues, the bug fields (see issue_create). A new issue from title or request cannot carry bug fields.',
    inputSchema: NormalStart,
  },
  {
    name: 'issue_list',
    commandName: 'list',
    description: 'List repository issues with native filters, named organization fields and pagination',
    inputSchema: z.strictObject({ ...IssueListing, query: SearchText.optional() }),
  },
  {
    name: 'issue_search',
    commandName: 'search',
    description: 'Search literal issue text in the selected repository with native filters and pagination',
    inputSchema: z.strictObject({ ...IssueListing, query: SearchText }),
  },
  {
    name: 'issue_update',
    commandName: 'update',
    description: 'Update native issue fields and exact relationship sets with readback',
    inputSchema: IssueUpdateInput.safeExtend({ verbose: Verbose }),
  },
  {
    name: 'issue_batch_update',
    commandName: 'batch:update',
    description: 'Plan or apply 1–50 issue updates in one repository, with ordered partial results and readback',
    inputSchema: issueInputSchema(
      z.strictObject({
        repo: Repo,
        verbose: Verbose,
        items: z.array(IssueUpdateInput).min(1).max(50),
        dryRun: z.boolean().optional(),
      }),
    ),
  },
  {
    name: 'issue_info',
    commandName: 'info',
    description:
      'Read live GitHub issue metadata, relationships, Project status, linked PRs (state, checks, reviews) and the latest journal in one call. Child counts by default; verbose adds the body, routing and full child progress. Pass the requested owner/name as repo; an explicit repo works outside Git without a checkout. This read does not start or update the issue.',
    inputSchema: z.strictObject({ issueNumber: Positive, repo: Repo, verbose: Verbose }),
  },
  {
    name: 'issue_ready_check',
    commandName: 'ready:check',
    description: 'Evaluate deterministic readiness from live native issue state',
    inputSchema: z.strictObject({ issueNumber: Positive, repo: Tracking.repo, verbose: Verbose }),
  },
  {
    name: 'issue_pr_create',
    commandName: 'pr:create',
    description:
      'Create or reuse an issue-closing PR from any directory using repo, issueNumber and a pushed head. Restore a missing closing link on reuse.',
    inputSchema: z
      .strictObject({
        repo: Repo,
        verbose: Verbose,
        issueNumber: Positive,
        prNumber: Positive.optional(),
        nonClosing: z.boolean().optional(),
        reconcileNonClosingReference: z.boolean().optional(),
        expectedHeadSha: z
          .string()
          .regex(/^[a-f0-9]{40}$/u)
          .optional(),
        expectedBaseSha: z
          .string()
          .regex(/^[a-f0-9]{40}$/u)
          .optional(),
        body: z.string().min(1, 'PR body is empty; enter a body or omit it to use the default body.').optional(),
        draft: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        title: z.string().min(1, 'PR title is empty; enter a title or omit it to use the issue title.').optional(),
        headBranch: z.string().min(1).optional(),
        head: z.string().min(1).optional(),
        base: z.string().min(1).optional(),
      })
      .refine(
        (input) => input.head === undefined || input.headBranch === undefined || input.head === input.headBranch,
        'PR head selectors disagree; use the same branch for head and headBranch.',
      )
      .refine(
        (input) =>
          input.reconcileNonClosingReference === true
            ? input.nonClosing === true &&
              input.draft !== false &&
              input.body !== undefined &&
              input.expectedHeadSha !== undefined &&
              input.expectedBaseSha !== undefined
            : input.expectedHeadSha === undefined && input.expectedBaseSha === undefined,
        'Reference reconciliation requires explicit nonClosing, DRAFT, body and exact head/base; SHA inputs require the action.',
      ),
  },
  {
    name: 'issue_pr_info',
    commandName: 'pr:info',
    description:
      "Inspect a PR by number or its GitHub-linked issue branch: state, merge state, checks, reviews and each linked issue's state, Project status and latest journal, in one call",
    inputSchema: z.strictObject({
      repo: Repo,
      verbose: Verbose,
      issueNumber: Positive.optional(),
      prNumber: Positive.optional(),
      nonClosing: z.boolean().optional(),
    }),
  },
  {
    name: 'issue_pr_review',
    commandName: 'pr:review',
    description: 'Submit one existing exact-head independent review with the reviewer App role',
    inputSchema: z.strictObject({
      repo: Repo,
      verbose: Verbose,
      issueNumber: Positive,
      prNumber: Positive,
      nonClosing: z.boolean().optional(),
      artifact: z.string().min(1, 'Review artifact is empty; provide the independent review artifact JSON.'),
      identity: z.string().min(1).optional(),
      dryRun: z.boolean().optional(),
    }),
  },
] as const;

export type AiDeliveryMcpToolName = (typeof AI_DELIVERY_MCP_TOOLS)[number]['name'];

export function getAiDeliveryMcpTool(name: string): (typeof AI_DELIVERY_MCP_TOOLS)[number] | null {
  return AI_DELIVERY_MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}
