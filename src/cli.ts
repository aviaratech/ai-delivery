#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDeliveryGitHubClients } from './github/client.js';
import { appCredentialSource, loadDeliverySettings } from './config/deliveryConfig.js';
import { Command } from 'commander';
import { z } from 'zod';

import { printCommandError, printCommandResult } from './cliResult.js';
import { contextFor, executeTool, type ExecutionContext } from './dispatch.js';
import { listIssueSubissues } from './issue.js';
import { listPrs, preflightReviewRoute, prChecks, submitFormalReview } from './pr.js';
import {
  assertReviewVerdictTarget,
  buildReviewArtifact,
  parseReviewVerdict,
  ReviewSubmissionError,
  validateReviewTarget,
} from './review.js';
import { serveAiDeliveryMcp } from './mcp/index.js';
import type { AiDeliveryMcpToolName } from './mcp/tools.js';
import { planOfflineLegacyIssueMigration } from './services/legacyIssueMigration.js';
import { PACKAGE_VERSION } from './version.js';
import { managePlugin } from './pluginInstaller.js';
import { IssueWriteSchema, IssueStatusPatch, IssueDeferralPatch, ProjectStatusPatch } from './issueContract.js';
import { NativeIssueDateFields } from './github/nativeIssueMetadata.js';
import { DeliveryError } from './errors.js';
import { parseBoardReconcileRequest } from './services/boardReconcileService.js';
import { renderDeliveryBoard, type DeliveryBoardResult } from './deliveryBoard.js';

const program = new Command();
program
  .name('ai-delivery')
  .description('Generic GitHub issue and pull request delivery')
  .version(PACKAGE_VERSION)
  .option('--identity <name>', 'Configured author or reviewer identity')
  .option('--personal-auth', 'Explicit legacy personal-token author override')
  .option('--json', 'Print JSON output')
  .option('--verbose', 'Include full bodies, diffs and routing with --json')
  .option('--repo <owner/name>', 'GitHub repository owner/name; works from any directory')
  .option('--repo-root <path>', 'Launch directory or explicit clone for local operations', process.cwd());

// Only the plugin command group owns a local --version input. Skip global option
// values when selecting its parser so an unrelated argument named plugin has no effect.
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]!;
  const option = program.options.find((value) => value.long === argument.split('=')[0] || value.short === argument);
  if (option) {
    if (option.required && !argument.includes('=')) index++;
    continue;
  }
  if (argument === 'plugin') program.enablePositionalOptions();
  break;
}

function execution(): ExecutionContext {
  const options = program.opts<{ identity?: string; personalAuth?: boolean; repo?: string; repoRoot: string }>();
  const identity = (options.identity ?? process.env.AI_DELIVERY_IDENTITY)?.trim() || undefined;
  return {
    repoRoot: options.repoRoot,
    ...(identity === undefined ? {} : { identity }),
    personalAuth: options.personalAuth === true,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
  };
}
function int(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}
function list(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}
function ints(value: string | undefined): number[] | undefined {
  return list(value)?.map(Number);
}
function body(value: string | undefined, file: string | undefined): string | undefined {
  if (value !== undefined && file !== undefined) throw new Error('Pass either --body or --body-file.');
  return file === undefined ? value : readFileSync(file, 'utf8');
}
function fields(file: string | undefined, overrides: Record<string, unknown>, update = false): Record<string, unknown> {
  const value: unknown = file === undefined ? {} : JSON.parse(readFileSync(file, 'utf8'));
  return {
    ...IssueWriteSchema.extend({
      ...NativeIssueDateFields,
      ...IssueDeferralPatch,
      status: IssueStatusPatch.optional(),
      ...(update ? { projectStatus: ProjectStatusPatch.optional() } : {}),
      preserveHistory: z.boolean().optional(),
    }).parse(value),
    ...Object.fromEntries(Object.entries(overrides).filter(([, item]) => item !== undefined)),
  };
}
function run(name: AiDeliveryMcpToolName, input: Record<string, unknown>): Promise<void> {
  const options = program.opts<{ json?: boolean; verbose?: boolean }>();
  return executeTool(name, input, execution()).then((value) =>
    printCommandResult(name, value, options.json === true && options.verbose === true),
  );
}
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function reconciliationFile(path: string): unknown {
  const limit = 16 * 1024 * 1024;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > limit)
    throw new DeliveryError('Reconciliation files must be regular UTF-8 JSON files of at most 16 MiB.');
  const bytes = readFileSync(path);
  if (bytes.byteLength > limit) throw new DeliveryError('Reconciliation files exceed 16 MiB.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

const plugin = program.command('plugin').description('Manage the ai-delivery native plugin');
for (const action of ['install', 'doctor', 'preview', 'update', 'rollback', 'remove'] as const) {
  const command = plugin
    .command(action)
    .requiredOption('--host <host>', 'Native host: codex or claude-code')
    .option('--scope <scope>', 'Native scope: user, project, or local; Codex supports user', 'user')
    .option('--dry-run', 'Describe the selected target without changing files or contacting native tools')
    .option('--json', 'Print the result as JSON');
  if (action === 'install' || action === 'update')
    command.requiredOption('--version <version>', 'Explicit published package version');
  if (action === 'doctor')
    command.option('--check-auth', 'Read configured role identities and repository access; requires explicit --repo');
  command.action(
    async (options: {
      host: string;
      scope: string;
      version?: string;
      dryRun?: boolean;
      json?: boolean;
      checkAuth?: boolean;
    }) => {
      const result = await managePlugin({
        action,
        host: options.host,
        scope: options.scope,
        ...(options.version === undefined ? {} : { version: options.version }),
        dryRun: options.dryRun === true,
        checkAuth: options.checkAuth === true,
        ...(options.checkAuth && execution().repo ? { repo: execution().repo } : {}),
        repoRoot: execution().repoRoot,
      });
      if (options.json) {
        print(result);
        return;
      }
      process.stdout.write(
        `${result.dryRun ? 'Dry run: ' : ''}${result.host} ${result.scope}: ${action}; version ${result.version ?? 'none'}; installed ${result.installed}; changed ${result.changed}\n`,
      );
      if (result.mcp)
        process.stdout.write(
          `Bundled MCP startup: ${result.mcp.startup}${result.mcp.error ? ` (${result.mcp.error})` : ''}\n`,
        );
      if (result.diagnostics) {
        process.stdout.write(
          `Registration observations: ${result.diagnostics.registrations.length}; completeness ${result.diagnostics.completeness}; migration ${result.diagnostics.migration}; planned changes ${result.diagnostics.plannedChanges.length}\n`,
        );
        for (const entry of result.diagnostics.registrations)
          process.stdout.write(
            `${entry.kind} ${entry.scope}: ownership ${entry.ownership}; source ${entry.source}; version ${entry.version ?? 'unknown'}\n`,
          );
        process.stdout.write(`Unverified conditions: ${result.diagnostics.findings.join(', ')}\n`);
      }
      if (result.activation)
        process.stdout.write(
          `Native session loaded version: unverified. Installed observation: ${result.activation.installedVersion ?? 'unknown'}; separate startup: ${result.activation.startupVersion ?? 'not checked'}. Use the host's surface-specific activation guidance.\n`,
        );
      if (result.recoveryRequired)
        process.stdout.write('Resume the interrupted original plugin command to recover this target.\n');
      if (result.authProbe)
        process.stdout.write(
          `Selected-runtime CLI auth probe: ${result.authProbe.outcome}; settings ${result.authProbe.settings}; process references ${result.authProbe.processReferences.status}; authentication ${result.authProbe.authentication.status}; repository access ${result.authProbe.repositoryAccess.status}${result.authProbe.reason ? ` (${result.authProbe.reason})` : ''}\nNative GUI credential propagation and counted exact-head approval remain unverified.\n`,
        );
    },
  );
}

program
  .command('runtime:stage')
  .description('Stage a reviewed archive in a private directory; does not activate or admit it')
  .requiredOption('--archive <path>')
  .requiredOption('--archive-sha256 <digest>')
  .requiredOption('--package-version <version>')
  .requiredOption('--source-commit <sha>')
  .requiredOption('--config-digest <digest>')
  .requiredOption('--runtime-directory <path>')
  .option('--native-plugin-root <path>', 'Bind the exact reviewed native plugin root')
  .option('--max-aggregate-rss-bytes <bytes>', 'Sampled controller plus children RSS limit')
  .option('--max-new-output-bytes <bytes>', 'Owned stage and metadata output limit')
  .option('--min-free-disk-bytes <bytes>', 'Required free disk headroom')
  .option('--max-captured-output-bytes <bytes>', 'Retained command log cap; defaults to 1 MiB')
  .option('--authorize-stage', 'Explicit authority to stage this reviewed archive')
  .action(async (o: Record<string, string | boolean>) =>
    run('runtime_stage', {
      authority: o.authorizeStage === true ? 'runtime:stage' : '',
      archivePath: o.archive,
      expectedArchiveSha256: o.archiveSha256,
      packageVersion: o.packageVersion,
      expectedSourceCommit: o.sourceCommit,
      expectedConfigDigest: o.configDigest,
      runtimeDirectory: o.runtimeDirectory,
      ...(o.nativePluginRoot === undefined ? {} : { nativePluginRoot: o.nativePluginRoot }),
      ...(['maxAggregateRssBytes', 'maxNewOutputBytes', 'minFreeDiskBytes', 'maxCapturedOutputBytes'].some(
        (key) => o[key] !== undefined,
      )
        ? {
            resourceBounds: {
              maxAggregateRssBytes: Number(o.maxAggregateRssBytes ?? 1024 ** 3),
              minFreeDiskBytes: Number(o.minFreeDiskBytes ?? 256 * 1024 ** 2),
              maxNewOutputBytes: Number(o.maxNewOutputBytes ?? 512 * 1024 ** 2),
              maxCapturedOutputBytes: Number(o.maxCapturedOutputBytes ?? 1024 ** 2),
            },
          }
        : {}),
    }),
  );

program
  .command('runtime:admit')
  .description('Explicitly publish the existing admission for an exact completed stage')
  .requiredOption('--stage-id <digest>')
  .requiredOption('--source-commit <sha>')
  .requiredOption('--config-digest <digest>')
  .requiredOption('--runtime-directory <path>')
  .option('--expected-prior <digest>', 'SHA-256 of the exact current private admission bytes')
  .option('--expected-absent', 'Explicitly require no current admission')
  .option('--authorize-admit', 'Explicit authority for the final admission write')
  .action(async (o: Record<string, string | boolean>) => {
    if ((o.expectedPrior === undefined) === (o.expectedAbsent !== true))
      throw new Error('Choose exactly one of --expected-prior or --expected-absent.');
    return run('runtime_admit', {
      authority: o.authorizeAdmit === true ? 'runtime:admit' : '',
      stageId: o.stageId,
      expectedSourceCommit: o.sourceCommit,
      expectedConfigDigest: o.configDigest,
      runtimeDirectory: o.runtimeDirectory,
      expectedPriorAdmissionSha256: o.expectedAbsent === true ? null : o.expectedPrior,
    });
  });

program
  .command('create')
  .requiredOption('--title <title>')
  .option('--fields-file <path>', 'UTF-8 JSON typed fields; explicit CLI fields take precedence')
  .option('--epic', 'Create an active unsized parent issue')
  .option('--op-id <id>', 'Stable identity for retrying the same create')
  .option('--draft', 'Explicitly write an incomplete parked draft')
  .option('--body <markdown>')
  .option('--body-file <path>')
  .option('--type <type>')
  .option('--points <number>')
  .option('--priority <priority>')
  .option('--labels <labels>')
  .option('--blocked-by <numbers>')
  .option('--blocks <numbers>', 'Add this issue as a blocker of these dependents')
  .option('--override-reason <reason>', 'Required explanation when adding a blocker to active work')
  .option('--milestone <number>')
  .option('--parent <number>')
  .action(async (o: Record<string, string> & { draft?: boolean; epic?: boolean }) =>
    run(
      'issue_create',
      fields(o.fieldsFile, {
        title: o.title,
        epic: o.epic,
        opId: o.opId,
        body: body(o.body, o.bodyFile),
        issueType: o.type,
        points: int(o.points),
        priority: o.priority,
        labels: list(o.labels),
        blockedBy: ints(o.blockedBy),
        blocks: ints(o.blocks),
        overrideReason: o.overrideReason,
        milestone: int(o.milestone),
        parentIssueNumber: int(o.parent),
        ...(o.draft === true ? { draft: true } : {}),
      }),
    ),
  );

program
  .command('start')
  .option('--issue <number>')
  .option('--request <text>')
  .option('--request-id <id>', 'Stable retry identity for a new issue start')
  .option('--title <title>')
  .option('--body <markdown>')
  .option('--body-file <path>')
  .option('--type <type>')
  .option('--points <number>')
  .option('--priority <priority>')
  .option('--labels <labels>')
  .option('--blocked-by <numbers>')
  .option('--blocks <numbers>', 'Add this issue as a blocker of these dependents')
  .option('--override-reason <reason>', 'Capacity override reason, or explanation when adding a blocker to active work')
  .option('--milestone <number>')
  .option('--parent <number>')
  .option('--branch <branch>')
  .option('--resume-created')
  .option('--investigation-worktree <path>', 'Prospectively register an already linked host-created investigation')
  .option('--expected-head <sha>', 'Exact unchanged initial commit for investigation registration')
  .action(async (o: Record<string, string | boolean>) => {
    if (o.investigationWorktree !== undefined || o.expectedHead !== undefined) {
      if (Object.keys(o).some((key) => !['issue', 'investigationWorktree', 'expectedHead'].includes(key)))
        throw new Error('Investigation registration cannot create or change issue/branch metadata.');
      return run('issue_start', {
        issueNumber: int(o.issue as string),
        investigationWorktree: o.investigationWorktree,
        expectedHeadSha: o.expectedHead,
      });
    }
    return run('issue_start', {
      issueNumber: int(o.issue as string),
      request: o.request,
      requestId: o.requestId,
      title: o.title,
      body: body(o.body as string, o.bodyFile as string),
      issueType: o.type,
      points: int(o.points as string),
      priority: o.priority,
      labels: list(o.labels as string),
      blockedBy: ints(o.blockedBy as string),
      blocks: ints(o.blocks as string),
      overrideReason: o.overrideReason,
      milestone: int(o.milestone as string),
      parentIssueNumber: int(o.parent as string),
      branch: o.branch,
      resumeCreated: o.resumeCreated === true,
    });
  });

for (const name of ['list', 'search'] as const) {
  program
    .command(name)
    .option('--query <text>', 'Literal text to search in the selected repository')
    .option('--state <state>')
    .option('--labels <labels>')
    .option('--parent <number>')
    .option('--type <type>')
    .option('--project-status <status>')
    .option('--updated-since <timestamp>')
    .option('--page <number>')
    .option('--per-page <number>')
    .action(async (o: Record<string, string>) =>
      run(name === 'list' ? 'issue_list' : 'issue_search', {
        query: o.query,
        state: o.state,
        labels: list(o.labels),
        parentIssueNumber: int(o.parent),
        issueType: o.type,
        projectStatus: o.projectStatus,
        updatedSince: o.updatedSince,
        page: int(o.page),
        perPage: int(o.perPage),
      }),
    );
}

program
  .command('update')
  .requiredOption('--issue <number>')
  .option('--fields-file <path>', 'UTF-8 JSON typed issue field patch')
  .option('--draft', 'Explicitly write an incomplete parked draft')
  .option('--title <title>')
  .option('--body <markdown>')
  .option('--body-file <path>')
  .option('--type <type>')
  .option('--points <number>')
  .option('--priority <priority>')
  .option('--labels <labels>')
  .option('--blocked-by <numbers>')
  .option('--blocks <numbers>', 'Add this issue as a blocker of these dependents')
  .option('--override-reason <reason>', 'Required explanation when adding a blocker to active work')
  .option('--milestone <number>')
  .option('--parent <number>')
  .option('--state <state>')
  .option('--project-status <status>', 'Set Todo, In Progress, Blocked or Done with a public reason')
  .option('--project-status-reason <reason>', 'Required public reason for an explicit Project Status')
  .option('--preserve-history', 'Preserve the previous title and body before a rewrite')
  .option('--close-reason <reason>')
  .option('--superseded-by <number>')
  .option('--park', 'Park execution while retaining the issue worktree')
  .option('--defer', 'Defer until an explicit undefer')
  .option('--defer-until <date>', 'Record an ISO date condition without automatic undeferral')
  .option('--defer-trigger <text>', 'Record the condition for reconsidering deferred work')
  .option('--undefer', 'Explicitly clear deferral; draft and park remain unchanged')
  .action(
    async (
      o: Record<string, string> & {
        park?: boolean;
        preserveHistory?: boolean;
        draft?: boolean;
        defer?: boolean;
        undefer?: boolean;
      },
    ) =>
      run(
        'issue_update',
        fields(
          o.fieldsFile,
          {
            issueNumber: int(o.issue),
            title: o.title,
            ...(o.draft === true ? { draft: true } : {}),
            body: body(o.body, o.bodyFile),
            issueType: o.type,
            points: int(o.points),
            priority: o.priority,
            labels: list(o.labels),
            blockedBy: ints(o.blockedBy),
            blocks: ints(o.blocks),
            overrideReason: o.overrideReason,
            milestone: int(o.milestone),
            parentIssueNumber: int(o.parent),
            state: o.state,
            projectStatus:
              o.projectStatus === undefined && o.projectStatusReason === undefined
                ? undefined
                : ProjectStatusPatch.parse({ status: o.projectStatus, reason: o.projectStatusReason }),
            preserveHistory: o.preserveHistory === true ? true : undefined,
            closeReason: o.closeReason,
            supersededBy: int(o.supersededBy),
            park: o.park === true ? true : undefined,
            defer:
              o.defer === true || o.deferUntil !== undefined || o.deferTrigger !== undefined
                ? {
                    ...(o.deferUntil === undefined ? {} : { until: o.deferUntil }),
                    ...(o.deferTrigger === undefined ? {} : { trigger: o.deferTrigger }),
                  }
                : undefined,
            undefer: o.undefer === true ? true : undefined,
          },
          true,
        ),
      ),
  );

program
  .command('board')
  .description('Read delivery attention and readiness for explicit repositories')
  .requiredOption('--repos <owner/repo,...>', 'Explicit GitHub repositories, separated by commas')
  .option('--decision-labels <label,...>', 'Additional labels that signal human attention')
  .option('--json', 'Print the complete board as JSON')
  .action(async (options: { repos: string; decisionLabels?: string; json?: boolean }) => {
    // Preserve empty selectors and control characters for the common validator.
    const result = (await executeTool(
      'delivery_board',
      { repos: options.repos.split(','), decisionLabels: options.decisionLabels?.split(',') },
      execution(),
    )) as DeliveryBoardResult;
    if (options.json || program.opts<{ json?: boolean }>().json) print(result);
    else process.stdout.write(`${renderDeliveryBoard(result)}\n`);
  });

program
  .command('board:reconcile')
  .description('Plan or apply bounded Project reconciliation for explicit repositories')
  .requiredOption('--repositories <owner/repo...>', '1–10 explicit GitHub repositories')
  .option('--checkouts-file <path>', 'UTF-8 JSON checkout selectors for dry-run')
  .option('--dry-run', 'Collect a plan without writes (default)')
  .option('--apply', 'Apply the retained original plan')
  .option('--plan-file <path>', 'Original complete reconciliation plan JSON')
  .option('--prior-result-file <path>', 'Optional prior result JSON for the exact original plan')
  .action(
    async (options: {
      repositories: string[];
      checkoutsFile?: string;
      dryRun?: boolean;
      apply?: boolean;
      planFile?: string;
      priorResultFile?: string;
    }) => {
      if (options.dryRun && options.apply) throw new DeliveryError('Choose either --dry-run or --apply.');
      const request = parseBoardReconcileRequest({
        repositories: options.repositories,
        ...(execution().repo === undefined ? {} : { repo: execution().repo }),
        mode: options.apply ? 'apply' : 'dry-run',
        ...(options.checkoutsFile === undefined ? {} : { checkouts: reconciliationFile(options.checkoutsFile) }),
        ...(options.planFile === undefined ? {} : { plan: reconciliationFile(options.planFile) }),
        ...(options.priorResultFile === undefined ? {} : { priorResult: reconciliationFile(options.priorResultFile) }),
      });
      return run('board_reconcile', request);
    },
  );

program
  .command('batch:update')
  .description('Plan or apply 1–50 current-repository issue updates with ordered readback')
  .requiredOption('--items-file <path>', 'UTF-8 JSON array of complete issue_update inputs')
  .option('--dry-run', 'Return plans and readback without any native writes')
  .action(async (o: { itemsFile: string; dryRun?: boolean }) =>
    run('issue_batch_update', {
      items: JSON.parse(readFileSync(o.itemsFile, 'utf8')) as unknown,
      dryRun: o.dryRun === true,
    }),
  );

program
  .command('health')
  .requiredOption('--from <utc>', 'Inclusive UTC ISO timestamp')
  .requiredOption('--to <utc>', 'Exclusive UTC ISO timestamp')
  .option('--max-issues <number>')
  .option('--max-timeline-pages <number>')
  .option('--max-project-pages <number>')
  .option('--oldest-limit <number>')
  .action(async (o: Record<string, string>) =>
    run('delivery_health', {
      repo: execution().repo,
      from: o.from,
      to: o.to,
      maxIssues: int(o.maxIssues),
      maxTimelinePages: int(o.maxTimelinePages),
      maxProjectPages: int(o.maxProjectPages),
      oldestLimit: int(o.oldestLimit),
    }),
  );
program
  .command('info')
  .requiredOption('--issue <number>')
  .action(async (o: { issue: string }) => run('issue_info', { issueNumber: int(o.issue) }));
program
  .command('ready:check')
  .requiredOption('--issue <number>')
  .action(async (o: { issue: string }) => run('issue_ready_check', { issueNumber: int(o.issue) }));
for (const field of ['parent', 'blockers'] as const) {
  program
    .command(field)
    .requiredOption('--issue <number>')
    .action(async (o: { issue: string }) => {
      const info = (await executeTool('issue_info', { issueNumber: int(o.issue) }, execution())) as {
        parentIssueNumber: number | null;
        blockedBy: number[];
      };
      print(
        field === 'parent'
          ? { issueNumber: int(o.issue), parentIssueNumber: info.parentIssueNumber }
          : { issueNumber: int(o.issue), blockedBy: info.blockedBy },
      );
    });
}
program
  .command('subissues')
  .requiredOption('--issue <number>')
  .action(async (o: { issue: string }) => {
    const context = await contextFor(execution(), 'subissues');
    print({ issueNumber: int(o.issue), subissues: await listIssueSubissues(context, Number(o.issue)) });
  });
program
  .command('pr:create')
  .description('Create or reuse an issue-closing PR from a pushed --head, from any directory.')
  .requiredOption('--issue <number>')
  .option('--pr <number>', 'Exact existing PR selector; never creates a replacement')
  .option('--non-closing', 'Retain the issue OPEN using native non-closing reference proof')
  .option(
    '--reconcile-non-closing-reference',
    'Explicit native closing-pair removal request; caller must hold exact authority and reconcile prior attempts',
  )
  .option('--expected-head <sha>', 'Exact source SHA for the explicit reference action')
  .option('--expected-base <sha>', 'Exact default-base SHA for the explicit reference action')
  .option('--title <title>')
  .option('--body-file <path>')
  .option('--head <branch>', 'Pushed remote head; no ai-delivery branch or worktree setup required')
  .option('--base <branch>', 'Repository default branch (inferred when omitted)')
  .option('--ready', 'Publish ready, or promote the author-owned PR selected by --head')
  .option('--dry-run')
  .action(
    async (o: {
      issue: string;
      pr?: string;
      nonClosing?: boolean;
      reconcileNonClosingReference?: boolean;
      expectedHead?: string;
      expectedBase?: string;
      title?: string;
      bodyFile?: string;
      head?: string;
      base?: string;
      ready?: boolean;
      dryRun?: boolean;
    }) =>
      run('issue_pr_create', {
        issueNumber: int(o.issue),
        prNumber: int(o.pr),
        nonClosing: o.nonClosing,
        reconcileNonClosingReference: o.reconcileNonClosingReference,
        expectedHeadSha: o.expectedHead,
        expectedBaseSha: o.expectedBase,
        title: o.title,
        body: body(undefined, o.bodyFile),
        headBranch: o.head,
        base: o.base,
        draft: o.ready !== true,
        dryRun: o.dryRun === true,
      }),
  );
program
  .command('pr:info')
  .description('Inspect an exact PR; combine --issue and --pr to verify its native closing-issue association.')
  .option('--non-closing', 'Verify an exact native non-closing PR-to-issue reference')
  .option('--issue <number>', 'Issue to verify; issue-only lookup requires a GitHub-linked branch')
  .option('--pr <number>', 'Exact PR number; include --issue after issue branch links are replaced on publication')
  .action(async (o: { issue?: string; pr?: string; nonClosing?: boolean }) =>
    run('issue_pr_info', { issueNumber: int(o.issue), prNumber: int(o.pr), nonClosing: o.nonClosing }),
  );
program
  .command('pr:list')
  .option('--state <state>', 'open, closed or all', 'open')
  .action(async (o: { state: string }) => {
    if (!['open', 'closed', 'all'].includes(o.state)) throw new Error('Invalid PR state.');
    const context = await contextFor(execution(), 'pr:list');
    print(await listPrs(context, o.state as 'open' | 'closed' | 'all'));
  });
program
  .command('pr:checks')
  .requiredOption('--pr <number>')
  .action(async (o: { pr: string }) => {
    const context = await contextFor(execution(), 'pr:checks');
    print(await prChecks(context, Number(o.pr)));
  });
program
  .command('pr:review')
  .requiredOption('--issue <number>')
  .requiredOption('--pr <number>')
  .requiredOption('--artifact <path>', 'Path to a UTF-8 JSON review artifact file (not inline JSON)')
  .option('--non-closing', 'Retain the referenced issue OPEN; finish refuses this mode')
  .option('--dry-run')
  .action(async (o: { issue: string; pr: string; artifact: string; dryRun?: boolean; nonClosing?: boolean }) =>
    run('issue_pr_review', {
      issueNumber: int(o.issue),
      prNumber: int(o.pr),
      artifact: readFileSync(o.artifact, 'utf8'),
      dryRun: o.dryRun === true,
      nonClosing: o.nonClosing,
    }),
  );
program
  .command('review')
  .argument('<action>', 'submit or doctor')
  .description('Submit an independent verdict or check its configured App')
  .option('--pr <number>', 'Required for submit')
  .option('--head <sha>', 'Required exact head for submit')
  .option('--identity <name>', 'Required configured reviewer profile')
  .option('--verdict <path>', 'Required for submit: UTF-8 JSON verdict, at most 64 KiB')
  .action(async (action: string, o: { pr?: string; head?: string; identity?: string; verdict?: string }) => {
    if (!['submit', 'doctor'].includes(action)) throw new DeliveryError('review action must be submit or doctor.');
    const identity = o.identity ?? execution().identity ?? '';
    const settings = await loadDeliverySettings(undefined, { reviewerIdentity: identity, prepareEnvironment: true });
    const profile = settings.roles.reviewer;
    if (!('appId' in profile))
      throw new DeliveryError('identity: Select a reviewer profile with explicit App/provider binding.');
    if (action === 'doctor') {
      if (o.pr !== undefined || o.head !== undefined || o.verdict !== undefined)
        throw new DeliveryError('review doctor does not accept submission inputs.');
      const clients = await createDeliveryGitHubClients({
        config: settings,
        identity,
        role: 'reviewer',
        env: settings.environment!,
      });
      const actorLogin = await clients.appActorLogin!();
      printCommandResult('review:doctor', {
        status: 'authenticated',
        identity,
        provider: profile.provider,
        appId: profile.appId,
        installationId: profile.installationId,
        actorLogin,
        source: appCredentialSource(profile).type,
      });
      return;
    }
    if (o.pr === undefined || o.head === undefined || o.verdict === undefined)
      throw new DeliveryError('review submit requires --pr, --head and --verdict.');
    const fd = openSync(o.verdict, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    let verdictFileSha256: string;
    try {
      if (!fstatSync(fd).isFile()) throw new DeliveryError('verdict: Expected a regular file.');
      const bytes = Buffer.alloc(64 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > 64 * 1024) throw new DeliveryError('verdict: File exceeds 64 KiB.');
      const content = bytes.subarray(0, size);
      raw = content.toString('utf8');
      if (!Buffer.from(raw, 'utf8').equals(content)) throw new DeliveryError('verdict: Expected valid UTF-8.');
      verdictFileSha256 = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    } finally {
      closeSync(fd);
    }
    const verdict = parseReviewVerdict(raw);
    assertReviewVerdictTarget(verdict, profile.provider, o.head);
    const prNumber = z.number().int().positive().parse(Number(o.pr));
    const artifact = buildReviewArtifact({
      verdict,
      verdictFileSha256,
      identity,
      provider: profile.provider,
      expectedHead: o.head,
      prNumber,
      authorIdentity: settings.roles.author.identity,
    });
    const authorContext = await contextFor(
      { ...execution(), settings, identity, reviewSubmission: true },
      'pr:info',
      'author',
    );
    await validateReviewTarget(authorContext, artifact, prNumber);
    const clients = await createDeliveryGitHubClients({
      config: authorContext.config,
      identity,
      role: 'reviewer',
      selectedAuthor: authorContext.clients,
      ...(authorContext.credentialEnvironment === undefined ? {} : { env: authorContext.credentialEnvironment }),
    });
    const context = { ...authorContext, clients };
    try {
      printCommandResult(
        'review:submit',
        await submitFormalReview(context, {
          artifact: JSON.stringify(artifact),
          issueNumber: verdict.issueNumber,
          prNumber,
          ...(verdict.nonClosing === undefined ? {} : { nonClosing: verdict.nonClosing }),
        }),
      );
    } catch (error) {
      if (!(error instanceof ReviewSubmissionError)) throw error;
      process.stdout.write(
        `${JSON.stringify({ status: 'submission-unverified', submission: error.submission, nextAction: error.message })}\n`,
      );
      process.exitCode = 1;
    }
  });
const mergeQueue = program.command('merge').command('queue').description('Host-local canonical repository merge queue');
mergeQueue
  .command('add <pr>')
  .option('--issue <number>')
  .action((pr: string, o: { issue?: string }) =>
    run('issue_pr_merge', {
      prNumber: int(pr),
      ...(o.issue === undefined ? {} : { issueNumber: int(o.issue) }),
      queue: true,
    }),
  );
mergeQueue.command('status').action(() => run('issue_pr_merge_queue_status', {}));
mergeQueue.command('run').action(() => run('issue_pr_merge_queue_run', {}));

for (const [command, tool] of [
  ['pr:merge', 'issue_pr_merge'],
  ['finish', 'issue_finish'],
] as const) {
  const mergeCommand = program.command(command).requiredOption('--issue <number>');
  if (command === 'pr:merge') mergeCommand.requiredOption('--pr <number>');
  else mergeCommand.option('--pr <number>');
  mergeCommand
    .option('--strategy <method>')
    .option('--reviewed-head <sha>')
    .option('--non-closing', 'Retain the referenced issue OPEN; finish refuses this mode')
    .option('--dry-run');
  if (command === 'finish')
    mergeCommand
      .option('--investigation', 'Complete an unchanged prospectively registered investigation')
      .option('--result <path>', 'Durable independently reviewed result outside the removable worktree')
      .option('--authority-comment <number>', 'Exact native operator removal authority comment')
      .option('--acceptance-comment <number>', 'Exact configured-App result acceptance comment');
  mergeCommand.action(
    async (o: {
      issue: string;
      pr?: string;
      strategy?: string;
      reviewedHead?: string;
      dryRun?: boolean;
      nonClosing?: boolean;
      investigation?: boolean;
      result?: string;
      authorityComment?: string;
      acceptanceComment?: string;
    }) => {
      if (o.investigation === true) {
        if (
          o.pr !== undefined ||
          o.strategy !== undefined ||
          o.reviewedHead !== undefined ||
          o.nonClosing !== undefined
        )
          throw new Error('Investigation completion cannot accept PR or merge options.');
        return run(tool, {
          issueNumber: int(o.issue),
          investigation: true,
          resultPath: o.result,
          authorityCommentId: int(o.authorityComment),
          acceptanceCommentId: int(o.acceptanceComment),
          dryRun: o.dryRun === true,
        });
      }
      if (o.result !== undefined || o.authorityComment !== undefined || o.acceptanceComment !== undefined)
        throw new Error('Investigation evidence requires --investigation.');
      return run(tool, {
        issueNumber: int(o.issue),
        prNumber: int(o.pr),
        strategy: o.strategy,
        reviewedHeadSha: o.reviewedHead,
        dryRun: o.dryRun === true,
        nonClosing: o.nonClosing,
      });
    },
  );
}
program
  .command('worktree:transition:inspect')
  .requiredOption('--issue <number>')
  .requiredOption('--purpose <purpose>', 'active-resume or merged-cleanup')
  .option('--disposition <disposition>', 'retain (default) or explicitly unheld remove')
  .option('--terminal-pr <number>')
  .option('--retained-holds <comment-ids>', 'Comma-separated native retained-hold comment IDs')
  .option('--retained-admission <path>')
  .option('--retained-archive <path>')
  .action(async (o: Record<string, string | undefined>) =>
    run('issue_worktree_transition_inspect', {
      issueNumber: int(o.issue),
      purpose: o.purpose,
      ...(o.disposition === undefined ? {} : { disposition: o.disposition }),
      ...(o.terminalPr === undefined ? {} : { terminalPrNumber: int(o.terminalPr) }),
      ...(o.retainedHolds === undefined ? {} : { retainedHoldCommentIds: ints(o.retainedHolds) }),
      ...(o.retainedAdmission === undefined ? {} : { retainedAdmissionPath: o.retainedAdmission }),
      ...(o.retainedArchive === undefined ? {} : { retainedArchivePath: o.retainedArchive }),
    }),
  );
program
  .command('worktree:transition:apply')
  .requiredOption('--plan <path>')
  .requiredOption('--plan-id <digest>')
  .requiredOption('--relinquishment-comment <id>')
  .requiredOption('--acceptance-comment <id>')
  .option('--authorize-transition', 'Explicit authority for this exact independently accepted plan')
  .action(async (o: Record<string, string | boolean>) =>
    run('issue_worktree_transition_apply', {
      authority: o.authorizeTransition === true ? 'worktree:transition' : '',
      planPath: o.plan,
      expectedPlanId: o.planId,
      relinquishmentCommentId: Number(o.relinquishmentComment),
      acceptanceCommentId: Number(o.acceptanceComment),
    }),
  );
program
  .command('migrate:legacy-issues')
  .requiredOption('--input-file <path>', 'Offline legacy issue inventory JSON')
  .action((o: { inputFile: string }) => {
    const report = planOfflineLegacyIssueMigration(JSON.parse(readFileSync(o.inputFile, 'utf8')) as unknown);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
program
  .command('config:resolve')
  .description('Read the effective GitHub destination and admission digest')
  .action(async () => {
    const context = await contextFor(execution(), 'config:resolve');
    print({
      configDigest: context.configuration?.configDigest,
      routing: context.configuration?.routing,
      reviewRoute: await preflightReviewRoute(context, undefined, undefined, 'development'),
    });
  });
program.command('mcp:serve').action(async () => serveAiDeliveryMcp(execution()));

program.parseAsync(process.argv).catch((error: unknown) => {
  const options = program.opts<{ json?: boolean; verbose?: boolean }>();
  printCommandError(error, options.json === true && options.verbose === true);
});
