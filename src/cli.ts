#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';

import { printCommandResult } from './cliResult.js';
import { contextFor, executeTool, type ExecutionContext } from './dispatch.js';
import { listIssueSubissues } from './issue.js';
import { listPrs, preflightReviewRoute, prChecks } from './pr.js';
import { serveAiDeliveryMcp } from './mcp/index.js';
import type { AiDeliveryMcpToolName } from './mcp/tools.js';
import { planOfflineLegacyIssueMigration } from './services/legacyIssueMigration.js';
import { PACKAGE_VERSION } from './version.js';
import { managePlugin } from './pluginInstaller.js';

const program = new Command();
program
  .name('ai-delivery')
  .description('Generic GitHub issue and pull request delivery')
  .version(PACKAGE_VERSION)
  .option('--identity <name>', 'Configured author or reviewer identity')
  .option('--personal-auth', 'Explicit legacy personal-token author override')
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
function run(name: AiDeliveryMcpToolName, input: Record<string, unknown>): Promise<void> {
  return executeTool(name, input, execution()).then((value) => printCommandResult(name, value));
}
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const plugin = program.command('plugin').description('Manage the ai-delivery native plugin');
for (const action of ['install', 'doctor', 'update', 'rollback', 'remove'] as const) {
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
  .option('--request-id <id>', 'Stable retry identity for a new issue start')
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
  .option('--resume-created')
  .action(async (o: Record<string, string | boolean>) =>
    run('issue_start', {
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
      milestone: int(o.milestone as string),
      parentIssueNumber: int(o.parent as string),
      branch: o.branch,
      resumeCreated: o.resumeCreated === true,
    }),
  );

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
  .option('--preserve-history', 'Preserve the previous title and body before a rewrite')
  .option('--close-reason <reason>')
  .option('--superseded-by <number>')
  .option('--park', 'Park execution while retaining the issue worktree')
  .action(async (o: Record<string, string> & { park?: boolean; preserveHistory?: boolean }) =>
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
      preserveHistory: o.preserveHistory === true ? true : undefined,
      closeReason: o.closeReason,
      supersededBy: int(o.supersededBy),
      park: o.park === true ? true : undefined,
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
  .description('Create a PR from a linked issue branch, or promote an existing associated PR with --head and --ready.')
  .requiredOption('--issue <number>')
  .option('--pr <number>', 'Exact existing PR selector; never creates a replacement')
  .option('--non-closing', 'Retain the issue OPEN using native non-closing reference proof')
  .option('--title <title>')
  .option('--body-file <path>')
  .option('--head <branch>', 'Explicit remote head; existing PR promotion verifies its native issue association')
  .option('--ready', 'Publish ready, or promote the author-owned PR selected by --head')
  .option('--dry-run')
  .action(
    async (o: {
      issue: string;
      pr?: string;
      nonClosing?: boolean;
      title?: string;
      bodyFile?: string;
      head?: string;
      ready?: boolean;
      dryRun?: boolean;
    }) =>
      run('issue_pr_create', {
        issueNumber: int(o.issue),
        prNumber: int(o.pr),
        nonClosing: o.nonClosing,
        title: o.title,
        body: body(undefined, o.bodyFile),
        headBranch: o.head,
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
for (const [command, tool] of [
  ['pr:merge', 'issue_pr_merge'],
  ['finish', 'issue_finish'],
] as const) {
  program
    .command(command)
    .requiredOption('--issue <number>')
    .requiredOption('--pr <number>')
    .option('--strategy <method>')
    .option('--reviewed-head <sha>')
    .option('--non-closing', 'Retain the referenced issue OPEN; finish refuses this mode')
    .option('--dry-run')
    .action(
      async (o: {
        issue: string;
        pr: string;
        strategy?: string;
        reviewedHead?: string;
        dryRun?: boolean;
        nonClosing?: boolean;
      }) =>
        run(tool, {
          issueNumber: int(o.issue),
          prNumber: int(o.pr),
          strategy: o.strategy,
          reviewedHeadSha: o.reviewedHead,
          dryRun: o.dryRun === true,
          nonClosing: o.nonClosing,
        }),
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

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`ai-delivery: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
