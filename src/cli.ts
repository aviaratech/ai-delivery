#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';

import { printCommandResult } from './cliResult.js';
import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { contextFor, executeTool, type ExecutionContext } from './dispatch.js';
import { git, gitExitCode, primaryGitRoot } from './git.js';
import { listIssueSubissues } from './issue.js';
import { checkoutPr, listPrs, preflightReviewRoute, prChecks } from './pr.js';
import { serveAiDeliveryMcp } from './mcp/index.js';
import type { AiDeliveryMcpToolName } from './mcp/tools.js';
import { planOfflineLegacyIssueMigration } from './services/legacyIssueMigration.js';
import { assertDeliveryRuntimeAdmitted } from './services/deliveryAdmission.js';
import { buildVelocityReport, getDeliveryRecords } from './services/deliveryRecordService.js';
import { listWorktreesStrict } from './services/worktreeRegistry.js';
import { cleanupNonIssueWorktree } from './worktree.js';

const program = new Command();
program
  .name('ai-delivery')
  .description('Generic GitHub issue and pull request delivery')
  .version('0.3.4')
  .option('--identity <name>', 'Configured author or reviewer identity')
  .option('--personal-auth', 'Explicit legacy personal-token author override')
  .option('--repo <owner/name>', 'Repository selector; must match the configured checkout')
  .option('--repo-root <path>', 'Target Git repository root', process.cwd());

function execution(): ExecutionContext {
  const options = program.opts<{ identity?: string; personalAuth?: boolean; repo?: string; repoRoot: string }>();
  const identity = options.identity ?? process.env.AI_DELIVERY_IDENTITY;
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
function run(name: AiDeliveryMcpToolName, input: Record<string, unknown>): Promise<void> {
  return executeTool(name, input, execution()).then((value) => printCommandResult(name, value));
}
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program
  .command('create')
  .requiredOption('--title <title>')
  .option('--body <markdown>')
  .option('--body-file <path>')
  .option('--type <type>')
  .option('--points <number>')
  .option('--priority <priority>')
  .option('--labels <labels>')
  .option('--blocked-by <numbers>')
  .option('--milestone <number>')
  .option('--parent <number>')
  .action(async (o: Record<string, string>) =>
    run('issue_create', {
      title: o.title,
      body: body(o.body, o.bodyFile),
      issueType: o.type,
      points: int(o.points),
      priority: o.priority,
      labels: list(o.labels),
      blockedBy: ints(o.blockedBy),
      milestone: int(o.milestone),
      parentIssueNumber: int(o.parent),
    }),
  );

program
  .command('start')
  .option('--issue <number>')
  .option('--request <text>')
  .option('--title <title>')
  .option('--body <markdown>')
  .option('--body-file <path>')
  .option('--type <type>')
  .option('--points <number>')
  .option('--priority <priority>')
  .option('--labels <labels>')
  .option('--blocked-by <numbers>')
  .option('--milestone <number>')
  .option('--parent <number>')
  .option('--branch <branch>')
  .option('--scratch')
  .option('--develop')
  .option('--resume-created')
  .action(async (o: Record<string, string | boolean>) =>
    run('issue_start', {
      issueNumber: int(o.issue as string),
      request: o.request,
      title: o.title,
      body: body(o.body as string, o.bodyFile as string),
      issueType: o.type,
      points: int(o.points as string),
      priority: o.priority,
      labels: list(o.labels as string),
      blockedBy: ints(o.blockedBy as string),
      milestone: int(o.milestone as string),
      parentIssueNumber: int(o.parent as string),
      branch: o.branch,
      scratch: o.scratch === true,
      develop: o.develop === true,
      resumeCreated: o.resumeCreated === true,
    }),
  );

program
  .command('update')
  .requiredOption('--issue <number>')
  .option('--title <title>')
  .option('--body <markdown>')
  .option('--body-file <path>')
  .option('--type <type>')
  .option('--points <number>')
  .option('--priority <priority>')
  .option('--labels <labels>')
  .option('--blocked-by <numbers>')
  .option('--milestone <number>')
  .option('--parent <number>')
  .option('--state <state>')
  .action(async (o: Record<string, string>) =>
    run('issue_update', {
      issueNumber: int(o.issue),
      title: o.title,
      body: body(o.body, o.bodyFile),
      issueType: o.type,
      points: int(o.points),
      priority: o.priority,
      labels: list(o.labels),
      blockedBy: ints(o.blockedBy),
      milestone: int(o.milestone),
      parentIssueNumber: int(o.parent),
      state: o.state,
    }),
  );

program
  .command('info')
  .requiredOption('--issue <number>')
  .option('--cached')
  .action(async (o: { issue: string; cached?: boolean }) =>
    run('issue_info', { issueNumber: int(o.issue), cached: o.cached === true }),
  );
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
  .command('develop')
  .requiredOption('--issue <number>')
  .option('--assignee <login>')
  .action(async (o: { issue: string; assignee?: string }) =>
    run('issue_develop', { issueNumber: int(o.issue), assignee: o.assignee }),
  );
program
  .command('verify')
  .requiredOption('--issue <number>')
  .option('--admit <classes>')
  .option('--max-aggregate-rss-bytes <bytes>')
  .option('--max-new-output-bytes <bytes>')
  .option('--min-free-disk-bytes <bytes>')
  .option(
    '--output-root <path>',
    'Filesystem output root; repeat for each root',
    (value: string, roots: string[]) => [...roots, value],
    [],
  )
  .option('--prepublication-review <path>')
  .action(
    async (o: {
      issue: string;
      admit?: string;
      maxAggregateRssBytes?: string;
      maxNewOutputBytes?: string;
      minFreeDiskBytes?: string;
      outputRoot?: string[];
      prepublicationReview?: string;
    }) =>
      run('issue_verify', {
        issueNumber: int(o.issue),
        admit: list(o.admit),
        ...(o.maxAggregateRssBytes === undefined &&
        o.maxNewOutputBytes === undefined &&
        o.minFreeDiskBytes === undefined &&
        (o.outputRoot?.length ?? 0) === 0
          ? {}
          : {
              resourceBounds: {
                maxAggregateRssBytes: int(o.maxAggregateRssBytes),
                ...(o.maxNewOutputBytes === undefined ? {} : { maxNewOutputBytes: int(o.maxNewOutputBytes) }),
                minFreeDiskBytes: int(o.minFreeDiskBytes),
                ...((o.outputRoot?.length ?? 0) === 0 ? {} : { outputRoots: o.outputRoot }),
              },
            }),
        prepublicationReview: o.prepublicationReview,
      }),
  );
program
  .command('pr:create')
  .requiredOption('--issue <number>')
  .option('--title <title>')
  .option('--body-file <path>')
  .option('--ready')
  .option('--dry-run')
  .action(async (o: { issue: string; title?: string; bodyFile?: string; ready?: boolean; dryRun?: boolean }) =>
    run('issue_pr_create', {
      issueNumber: int(o.issue),
      title: o.title,
      body: body(undefined, o.bodyFile),
      draft: o.ready !== true,
      dryRun: o.dryRun === true,
    }),
  );
program
  .command('pr:info')
  .option('--issue <number>')
  .option('--pr <number>')
  .action(async (o: { issue?: string; pr?: string }) =>
    run('issue_pr_info', { issueNumber: int(o.issue), prNumber: int(o.pr) }),
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
  .command('pr:checkout')
  .requiredOption('--pr <number>')
  .action(async (o: { pr: string }) => {
    const context = await contextFor(execution(), 'pr:checkout');
    await assertDeliveryRuntimeAdmitted({
      ...execution(),
      ...(context.configuration ? { configuration: context.configuration } : {}),
    });
    print(await checkoutPr(context, Number(o.pr)));
  });
program
  .command('pr:review')
  .requiredOption('--issue <number>')
  .requiredOption('--pr <number>')
  .requiredOption('--artifact <path>', 'Path to a UTF-8 JSON review artifact file (not inline JSON)')
  .option('--dry-run')
  .action(async (o: { issue: string; pr: string; artifact: string; dryRun?: boolean }) =>
    run('issue_pr_review', {
      issueNumber: int(o.issue),
      prNumber: int(o.pr),
      artifact: readFileSync(o.artifact, 'utf8'),
      dryRun: o.dryRun === true,
    }),
  );
for (const [command, tool] of [
  ['pr:merge', 'issue_pr_merge'],
  ['finish', 'issue_finish'],
] as const) {
  program
    .command(command)
    .requiredOption('--issue <number>')
    .requiredOption('--pr <number>')
    .option('--strategy <method>')
    .option('--dry-run')
    .action(async (o: { issue: string; pr: string; strategy?: string; dryRun?: boolean }) =>
      run(tool, {
        issueNumber: int(o.issue),
        prNumber: int(o.pr),
        strategy: o.strategy,
        dryRun: o.dryRun === true,
      }),
    );
}
program
  .command('worktree:create')
  .requiredOption('--name <name>')
  .requiredOption('--branch <branch>')
  .action(async (o: { name: string; branch: string }) => run('issue_worktree_create', o));
program.command('worktrees:list').action(() => print(listWorktreesStrict(primaryGitRoot(execution().repoRoot))));
program.command('worktrees:status').action(() => {
  const root = primaryGitRoot(execution().repoRoot);
  print(
    listWorktreesStrict(root).map((row) => {
      const present = existsSync(row.path) && gitExitCode(row.path, 'rev-parse', '--is-inside-work-tree') === 0;
      return {
        ...row,
        present,
        observedBranch: present ? git(row.path, 'branch', '--show-current') : null,
        clean: present ? git(row.path, 'status', '--porcelain', '--untracked-files=all') === '' : null,
      };
    }),
  );
});
program
  .command('worktrees:cleanup')
  .option('--pr <number>')
  .option('--name <name>')
  .action(async (o: { pr?: string; name?: string }) => {
    const context = await contextFor(execution(), 'worktrees:cleanup');
    await assertDeliveryRuntimeAdmitted({
      ...execution(),
      ...(context.configuration ? { configuration: context.configuration } : {}),
    });
    await cleanupNonIssueWorktree({
      ...(context.configuration?.remote ? { remote: context.configuration.remote } : {}),
      repoRoot: context.root,
      ...(o.pr === undefined ? {} : { prNumber: Number(o.pr) }),
      ...(o.name === undefined ? {} : { name: o.name }),
    });
    print({ cleaned: true, ...(o.pr === undefined ? { name: o.name } : { prNumber: Number(o.pr) }) });
  });
program
  .command('migrate:legacy-issues')
  .requiredOption('--input-file <path>', 'Offline legacy issue inventory JSON')
  .action((o: { inputFile: string }) => {
    const report = planOfflineLegacyIssueMigration(JSON.parse(readFileSync(o.inputFile, 'utf8')) as unknown);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
program
  .command('metrics')
  .description('Report bounded terminal delivery metrics')
  .command('velocity')
  .option('--json', 'Print the canonical JSON report')
  .action(async () => {
    const root = primaryGitRoot(execution().repoRoot);
    const config = (await loadDeliveryConfig(root)).config;
    const report = buildVelocityReport(getDeliveryRecords(root), new Date(), config.native.points.values.map(Number));
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
      reviewRoute: await preflightReviewRoute(context),
    });
  });
program.command('mcp:serve').action(async () => serveAiDeliveryMcp(execution()));

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`ai-delivery: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
