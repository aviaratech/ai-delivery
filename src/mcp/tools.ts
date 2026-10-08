import { z } from 'zod';
import { JournalInputSchema } from '../issueJournal.js';

const Positive = z.number().int().positive();
const Labels = z.array(z.string().regex(/^(?:area|risk):[^\s:]+$/u));
export const AI_DELIVERY_MCP_CONTRACT_VERSION = 'ai-delivery.mcp@1' as const;
const Tracking = {
  blockedBy: z.array(Positive).optional(),
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
    .optional(),
  title: z.string().trim().min(1).max(256),
};

const IssueListing = {
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
  identity: z.string().min(1).optional(),
  expectedSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  expectedConfigDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeDirectory: z.string().min(1),
};

export const AI_DELIVERY_MCP_TOOLS = [
  {
    name: 'issue_comment',
    commandName: 'comment',
    description: 'Post a typed issue journal with authoritative comment readback',
    inputSchema: JournalInputSchema,
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
    inputSchema: z.strictObject(Tracking),
  },
  {
    name: 'issue_start',
    commandName: 'start',
    description: 'Create or resume a tracked issue and optionally prepare its worktree',
    inputSchema: z.strictObject({
      ...Tracking,
      body: Tracking.body.optional(),
      issueType: Tracking.issueType.optional(),
      points: Tracking.points.optional(),
      priority: Tracking.priority.optional(),
      title: Tracking.title.optional(),
      issueNumber: Positive.optional(),
      request: z.string().min(1).optional(),
      develop: z.boolean().optional(),
      resumeCreated: z.boolean().optional(),
      scratch: z.boolean().optional(),
      branch: z.string().min(1).optional(),
    }),
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
    inputSchema: z
      .strictObject({
        blockedBy: z.array(Positive).optional(),
        body: z.string().optional(),
        issueNumber: Positive,
        issueType: z.string().min(1).optional(),
        labels: Labels.optional(),
        milestone: Positive.nullable().optional(),
        parentIssueNumber: Positive.nullable().optional(),
        park: z.literal(true).optional(),
        points: Positive.optional(),
        priority: z.string().min(1).optional(),
        state: z.enum(['open', 'closed']).optional(),
        preserveHistory: z.boolean().optional(),
        closeReason: z.enum(['completed', 'not_planned', 'duplicate']).optional(),
        supersededBy: Positive.optional(),
        title: z.string().trim().min(1).max(256).optional(),
      })
      .refine(
        (input) => (input.closeReason === undefined && input.supersededBy === undefined) || input.state === 'closed',
        'Closure details require state closed',
      ),
  },
  {
    name: 'issue_info',
    commandName: 'info',
    description: 'Read live issue metadata, relationships, Project status and registered worktree',
    inputSchema: z.strictObject({ issueNumber: Positive, cached: z.boolean().optional() }),
  },
  {
    name: 'issue_ready_check',
    commandName: 'ready:check',
    description: 'Evaluate deterministic readiness from live native issue state',
    inputSchema: z.strictObject({ issueNumber: Positive, repo: Tracking.repo }),
  },
  {
    name: 'issue_develop',
    commandName: 'develop',
    description: 'Prepare the one registered issue worktree after readiness passes',
    inputSchema: z.strictObject({ issueNumber: Positive, assignee: z.string().min(1).optional() }),
  },
  {
    name: 'issue_verify',
    commandName: 'verify',
    description: 'Resume exact-head policy stages and produce versioned delivery evidence',
    inputSchema: z.strictObject({
      issueNumber: Positive,
      admit: z.array(z.string().min(1)).optional(),
      prepublicationReview: z.string().min(1).optional(),
      resourceBounds: z
        .strictObject({
          maxAggregateRssBytes: z.number().int().positive().safe(),
          maxNewOutputBytes: z.number().int().positive().safe().optional(),
          minFreeDiskBytes: z.number().int().positive().safe(),
          outputRoots: z.array(z.string().min(1)).min(1).optional(),
        })
        .optional(),
    }),
  },
  {
    name: 'issue_pr_create',
    commandName: 'pr:create',
    description: 'Publish a verified draft or promote the unchanged reviewed PR',
    inputSchema: z.strictObject({
      issueNumber: Positive,
      body: z.string().min(1).optional(),
      draft: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      title: z.string().min(1).optional(),
    }),
  },
  {
    name: 'issue_pr_info',
    commandName: 'pr:info',
    description: 'Inspect a PR by PR number or by its registered issue branch',
    inputSchema: z.strictObject({ issueNumber: Positive.optional(), prNumber: Positive.optional() }),
  },
  {
    name: 'issue_pr_review',
    commandName: 'pr:review',
    description: 'Submit one existing exact-head independent review with the reviewer App role',
    inputSchema: z.strictObject({
      issueNumber: Positive,
      prNumber: Positive,
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
      issueNumber: Positive,
      prNumber: Positive,
      strategy: z.enum(['merge', 'squash', 'rebase']).optional(),
      dryRun: z.boolean().optional(),
    }),
  },
  {
    name: 'issue_finish',
    commandName: 'finish',
    description: 'Resume merge, issue completion and non-force worktree cleanup',
    inputSchema: z.strictObject({
      issueNumber: Positive,
      prNumber: Positive,
      strategy: z.enum(['merge', 'squash', 'rebase']).optional(),
      dryRun: z.boolean().optional(),
    }),
  },
  {
    name: 'issue_worktree_create',
    commandName: 'worktree:create',
    description: 'Prepare one explicit standalone worktree without an issue',
    inputSchema: z.strictObject({ name: z.string().min(1), branch: z.string().min(1) }),
  },
  {
    name: 'issue_worktree_transition_inspect',
    commandName: 'worktree:transition:inspect',
    description: 'Read a legacy issue row, original evidence and exact closure gaps without changing ownership',
    inputSchema: z.strictObject({
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
