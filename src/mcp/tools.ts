import { z } from 'zod';
import { DeliveryHealthInput } from '../services/deliveryHealthService.js';
import { OverrideReason } from '../services/blockerGuardService.js';
import { JournalInputSchema } from '../issueJournal.js';
import { IssueFields, IssueWriteFields, ISSUE_JSON_SCHEMAS, issueInputSchema } from '../issueContract.js';

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
const Tracking = {
  blockedBy: z.array(Positive).optional(),
  blocks: z.array(Positive).optional(),
  overrideReason: OverrideReason.optional(),
  body: z.string().optional(),
  issueType: z.string().min(1).optional(),
  labels: Labels.optional(),
  milestone: Positive.optional(),
  parentIssueNumber: Positive.optional(),
  points: Positive.optional(),
  priority: z.string().min(1).optional(),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .optional()
    .describe(REPO_HELP),
  title: z.string().trim().min(1).max(256),
};
const InvestigationStart = z.strictObject({
  repo: Repo,
  issueNumber: Positive,
  investigationWorktree: z.string().min(1),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/u),
});
const NormalStart = z.strictObject({
  ...Tracking,
  title: Tracking.title.optional(),
  issueNumber: Positive.optional(),
  request: z.string().min(1).optional(),
  requestId: z.string().trim().min(1).max(256).optional(),
  resumeCreated: z.boolean().optional(),
  branch: z.string().min(1).optional(),
});
const NormalFinish = z.strictObject({
  repo: Repo,
  issueNumber: Positive,
  prNumber: Positive,
  nonClosing: z.boolean().optional(),
  reviewedHeadSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .optional(),
  strategy: z.enum(['merge', 'squash', 'rebase']).optional(),
  dryRun: z.boolean().optional(),
});
const InvestigationFinish = z.strictObject({
  repo: Repo,
  issueNumber: Positive,
  investigation: z.literal(true),
  resultPath: z.string().min(1),
  authorityCommentId: Positive.optional(),
  acceptanceCommentId: Positive.optional(),
  dryRun: z.boolean().optional(),
});

function validateMode(schema: z.ZodType, input: unknown, context: z.RefinementCtx): void {
  const result = schema.safeParse(input);
  if (!result.success) context.addIssue({ code: 'custom', message: result.error.message });
}

const IssueListing = {
  repo: Repo,
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

const RuntimeController = {
  repo: Repo,
  identity: z.string().min(1).optional(),
  expectedSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  expectedConfigDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeDirectory: z.string().min(1),
};

export const AI_DELIVERY_MCP_TOOLS = [
  {
    name: 'delivery_health',
    commandName: 'health',
    description: 'Read bounded native delivery health for an explicit repository and UTC window',
    inputSchema: DeliveryHealthInput,
  },
  {
    name: 'issue_comment',
    commandName: 'comment',
    description: 'Post a typed issue journal with authoritative comment readback',
    inputSchema: z
      .strictObject({ ...JournalInputSchema.shape, repo: Repo })
      .superRefine(({ repo: _repo, ...journal }, ctx) => {
        // Repository routing belongs to the MCP envelope, not the strict journal variants.
        const parsed = JournalInputSchema.safeParse(journal);
        if (!parsed.success)
          for (const issue of parsed.error.issues)
            ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }),
  },
  {
    name: 'runtime_stage',
    commandName: 'runtime:stage',
    description: 'Explicitly stage a reviewed local public archive without host activation or admission',
    inputSchema: z.strictObject({
      ...RuntimeController,
      authority: z.literal('runtime:stage'),
      archivePath: z.string().min(1),
      expectedArchiveSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
      nativePluginRoot: z.string().min(1).optional(),
      resourceBounds: z
        .strictObject({
          maxAggregateRssBytes: z.number().int().positive().safe(),
          minFreeDiskBytes: z.number().int().positive().safe(),
          maxNewOutputBytes: z.number().int().positive().safe(),
          maxCapturedOutputBytes: z
            .number()
            .int()
            .positive()
            .safe()
            .max(8 * 1024 ** 2)
            .optional(),
        })
        .optional(),
    }),
  },
  {
    name: 'runtime_admit',
    commandName: 'runtime:admit',
    description: 'Explicitly admit an exact completed stage with prior-byte compare-and-swap and reconciliation',
    inputSchema: z.strictObject({
      ...RuntimeController,
      authority: z.literal('runtime:admit'),
      stageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      expectedPriorAdmissionSha256: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/u)
        .nullable(),
    }),
  },
  {
    name: 'issue_create',
    commandName: 'create',
    description: 'Create a native GitHub tracking issue with configured metadata and relationships',
    issueContract: ISSUE_JSON_SCHEMAS,
    inputSchema: issueInputSchema(z.strictObject({ ...Tracking, ...IssueWriteFields, title: IssueFields.shape.title })),
  },
  {
    name: 'issue_start',
    commandName: 'start',
    description: 'Start a linked issue, or prospectively register an unchanged host-created investigation worktree',
    inputSchema: NormalStart.extend({
      investigationWorktree: z.string().optional(),
      expectedHeadSha: z.string().optional(),
    }).superRefine((input, context) =>
      validateMode(
        input.investigationWorktree !== undefined || input.expectedHeadSha !== undefined
          ? InvestigationStart
          : NormalStart,
        input,
        context,
      ),
    ),
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
    inputSchema: issueInputSchema(
      z
        .strictObject({
          ...IssueWriteFields,
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
          points: IssueWriteFields.points,
          priority: z.string().min(1).optional(),
          state: z.enum(['open', 'closed']).optional(),
          preserveHistory: z.boolean().optional(),
          closeReason: z.enum(['completed', 'not_planned', 'duplicate']).optional(),
          supersededBy: Positive.optional(),
          title: IssueWriteFields.title,
        })
        .superRefine((input, ctx) => {
          if ((input.closeReason !== undefined || input.supersededBy !== undefined) && input.state !== 'closed')
            ctx.addIssue({
              code: 'custom',
              path: ['state'],
              message: 'Closure details require state closed',
              params: { issueCode: 'closure.state' },
            });
        }),
    ),
  },
  {
    name: 'issue_info',
    commandName: 'info',
    description:
      'Read live GitHub issue metadata, relationships and Project status. Pass the requested owner/name as repo; an explicit repo works outside Git without a checkout. This read does not start or update the issue.',
    inputSchema: z.strictObject({ issueNumber: Positive, repo: Repo }),
  },
  {
    name: 'issue_ready_check',
    commandName: 'ready:check',
    description: 'Evaluate deterministic readiness from live native issue state',
    inputSchema: z.strictObject({ issueNumber: Positive, repo: Tracking.repo }),
  },
  {
    name: 'issue_pr_create',
    commandName: 'pr:create',
    description: 'Create or reuse a PR from its GitHub-linked issue branch',
    inputSchema: z.strictObject({
      repo: Repo,
      issueNumber: Positive,
      prNumber: Positive.optional(),
      nonClosing: z.boolean().optional(),
      body: z.string().min(1).optional(),
      draft: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      title: z.string().min(1).optional(),
      headBranch: z.string().min(1).optional(),
    }),
  },
  {
    name: 'issue_pr_info',
    commandName: 'pr:info',
    description: 'Inspect a PR by number or its GitHub-linked issue branch',
    inputSchema: z.strictObject({
      repo: Repo,
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
      issueNumber: Positive,
      prNumber: Positive,
      nonClosing: z.boolean().optional(),
      artifact: z.string().min(1),
      identity: z.string().min(1).optional(),
      dryRun: z.boolean().optional(),
    }),
  },
  {
    name: 'issue_pr_merge',
    commandName: 'pr:merge',
    description: 'Guarded exact-head merge with live blocker, check and review readback',
    inputSchema: z.strictObject({
      repo: Repo,
      issueNumber: Positive,
      prNumber: Positive,
      nonClosing: z.boolean().optional(),
      reviewedHeadSha: z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .optional(),
      strategy: z.enum(['merge', 'squash', 'rebase']).optional(),
      dryRun: z.boolean().optional(),
    }),
  },
  {
    name: 'issue_finish',
    commandName: 'finish',
    description:
      'Finish merged delivery, or remove a prospectively registered unchanged investigation with native acceptance',
    inputSchema: NormalFinish.extend({
      prNumber: Positive.optional(),
      investigation: z.literal(true).optional(),
      resultPath: z.string().optional(),
      authorityCommentId: Positive.optional(),
      acceptanceCommentId: Positive.optional(),
    }).superRefine((input, context) =>
      validateMode(input.investigation === true ? InvestigationFinish : NormalFinish, input, context),
    ),
  },
  {
    name: 'issue_worktree_transition_inspect',
    commandName: 'worktree:transition:inspect',
    description: 'Read a legacy issue row, original evidence and exact closure gaps without changing ownership',
    inputSchema: z.strictObject({
      repo: Repo,
      issueNumber: Positive,
      purpose: z.enum(['active-resume', 'merged-cleanup']),
      disposition: z.enum(['retain', 'remove']).optional(),
      terminalPrNumber: Positive.optional(),
      retainedHoldCommentIds: z.array(Positive).optional(),
      retainedAdmissionPath: z.string().min(1).optional(),
      retainedArchivePath: z.string().min(1).optional(),
    }),
  },
  {
    name: 'issue_worktree_transition_apply',
    commandName: 'worktree:transition:apply',
    description:
      'Apply or resume one exact independently accepted transition with immutable preservation and closure proof',
    inputSchema: z.strictObject({
      repo: Repo,
      authority: z.literal('worktree:transition'),
      planPath: z.string().min(1),
      expectedPlanId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      relinquishmentCommentId: Positive,
      acceptanceCommentId: Positive,
    }),
  },
] as const;

export type AiDeliveryMcpToolName = (typeof AI_DELIVERY_MCP_TOOLS)[number]['name'];

export function getAiDeliveryMcpTool(name: string): (typeof AI_DELIVERY_MCP_TOOLS)[number] | null {
  return AI_DELIVERY_MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}
