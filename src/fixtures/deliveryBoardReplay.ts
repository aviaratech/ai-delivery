import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import type { LoadedDeliverySettings, GitHubDeliveryConfig, LoadedGitHubConfig } from '../config/deliveryConfig.js';
import type { DeliveryRouting } from '../github/discovery.js';
import * as configuration from '../config/deliveryConfig.js';
import type { ExecutionContext } from '../dispatch.js';
import { digestBytes, digestValue } from '../delivery/common.js';
import * as githubClients from '../github/client.js';
import * as issueOwner from '../issue.js';
import type { DeliveryContext } from '../issue.js';
import { renderJournal, type JournalInput } from '../issueJournal.js';
import * as projectOwner from '../github/projectDelivery.js';
import { fixtureGit } from './inertTarget.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig, syntheticOverrides } from './discovery.js';

export const boardReplayRepos = ['example/alpha', 'example/beta'];
export const boardReplayAsOf = '2026-10-23T12:00:00.000Z';
export interface BoardReplayOptions {
  selectedIssues?: number;
  longLinks?: boolean;
  asOf?: string;
  abortAfterRepository?: AbortController;
  unreadableRepository?: string;
  projectDenied?: boolean;
  readOnlyProject?: boolean;
  projectCursorRepeats?: boolean;
  status?: 'missing' | 'unsupported' | 'duplicate';
  ambiguousJournal?: boolean;
  journalDenied?: boolean;
  journalBackwards?: boolean;
  journalCursorRepeats?: boolean;
  wrongJournalParent?: boolean;
  searchCap?: boolean;
  searchCursorRepeats?: boolean;
  unknownMergeCommit?: boolean;
  duplicateSearchIds?: boolean;
  emptyMetrics?: boolean;
  windowEdges?: boolean;
  retainedLimit?: boolean;
  combinedRetainedLimit?: boolean;
  prReviewUnavailable?: boolean;
  prNativeUnavailable?: boolean;
  prChecksFailed?: boolean;
  movedBase?: boolean;
  oversizedPr?: boolean;
  contextPrincipal?: 'changed' | 'unavailable';
  contextIdentityMismatch?: boolean;
  lateMetricFailure?: boolean;
  recentBoundary?: boolean;
}

/** Fictional native projections. Only external client/context ports and forbidden writers are replaced. */
export function deliveryBoardReplay(options: BoardReplayOptions = {}) {
  const repos = options.longLinks
    ? boardReplayRepos.map((repository) => `${repository}-${'x'.repeat(90)}`)
    : boardReplayRepos;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-board-replay-')));
  const ownership = lstatSync(base);
  const roots = repos.map((_, i) => join(base, `repo-${i}`));
  const trap = join(base, 'target-code-executions.txt');
  const calls = {
    operations: {} as Record<string, number>,
    nativeWrites: 0,
    setupCalls: 0,
    perItemStatusReads: 0,
    unexpectedReads: 0,
    clientFactory: 0,
    contexts: 0,
  };
  const count = (name: string) => {
    calls.operations[name] = (calls.operations[name] ?? 0) + 1;
  };
  let disposed = false;
  const snapshot = (path: string) => {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    return {
      digest: digestBytes(readFileSync(path)),
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  };
  const configHashes = new Map<string, ReturnType<typeof snapshot>>();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (existsSync(base)) {
      const current = lstatSync(base);
      assert.equal(current.dev, ownership.dev);
      assert.equal(current.ino, ownership.ino);
      assert.equal(current.uid, ownership.uid);
      assert.equal(current.isSymbolicLink(), false);
      assert.equal(current.isDirectory(), true);
      rmSync(base, { recursive: true });
    }
    assert.equal(existsSync(base), false);
    console.log(
      JSON.stringify({
        fixture: 'delivery-board-synthetic',
        root: base,
        dev: ownership.dev,
        ino: ownership.ino,
        cleanupConfirmed: true,
        ...calls,
      }),
    );
  };
  onTestFinished(dispose);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(options.asOf ?? boardReplayAsOf));
  const asOf = Date.parse(options.asOf ?? boardReplayAsOf);
  const iso = (offset: number) => new Date(asOf + offset).toISOString();
  const day = 24 * 60 * 60 * 1000;
  const baseSha = 'c'.repeat(40);
  const sha = (number: number) => number.toString(16).padStart(40, '0');
  const index = (repository: string) => repos.indexOf(repository.toLowerCase());
  const repoId = (repository: string) => `REPO-${index(repository)}`;
  const issueId = (repository: string, number: number) => `ISSUE-${index(repository)}-${number}`;
  const prId = (repository: string, number: number) => `PR-${index(repository)}-${number}`;
  const native = (repository: string) => ({
    ...syntheticDiscoveryConfig,
    repository,
    native: structuredClone(syntheticDiscoveryConfig.native),
  });
  const { repository: _repository, ...overrides } = syntheticOverrides(syntheticDiscoveryConfig);
  const settings: LoadedDeliverySettings = {
    roles: {
      author: { authSource: 'personal', identity: 'fixture-author', credentialEnv: { token: 'SYNTHETIC_TOKEN' } },
      reviewer: {
        identity: 'fixture-reviewer',
        credentialEnv: {
          appId: 'SYNTHETIC_APP',
          installationId: 'SYNTHETIC_INSTALLATION',
          privateKeyPath: 'SYNTHETIC_KEY_PATH',
        },
      },
    },
    configPath: join(base, 'SYNTHETIC_PRIVATE_CONFIG'),
    overrides,
    checkoutRoots: [base],
    sourceDigest: digestValue({ fixture: 'delivery-board-settings' }),
  };
  const config = (repository: string): GitHubDeliveryConfig => ({
    ...native(repository),
    schemaVersion: 'ai-delivery.github@1',
    roles: settings.roles,
  });
  const configs = new Map(repos.map((repository) => [repository, config(repository)]));
  const selected = options.selectedIssues ?? 50;
  const selectedCount = (repository: string) => Math.max(0, Math.min(25, selected - index(repository) * 25));
  const observedIssue = (repository: string, number: number) => ({
    node_id: issueId(repository, number),
    number,
    title: options.combinedRetainedLimit && number === 1 ? 'x'.repeat(9 * 1024 * 1024) : `Synthetic issue ${number}`,
    html_url: `https://github.com/${repository}/issues/${number}`,
    state: 'open',
    labels: number === 5 ? [{ name: 'needs-decision' }] : [],
    updated_at: iso(
      number >= 6 && number <= 10
        ? -3 * day + (number === 6 ? 0 : options.recentBoundary && number === 7 ? 1 : -1)
        : -day,
    ),
  });
  const observedPr = (repository: string, number: number) => ({
    node_id: prId(repository, number),
    number,
    title:
      options.oversizedPr && index(repository) === 0 && number === 101
        ? 'x'.repeat(17 * 1024 * 1024)
        : `Synthetic PR ${number}`,
    html_url: `https://github.com/${repository}/pull/${number}`,
    body: `Closes #${number - 90}\n\nSynthetic proof.`,
    state: 'open',
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: number <= 105 ? 'clean' : 'blocked',
    head: {
      sha: sha(number + index(repository) * 1000),
      ref: `issue/${number - 90}`,
      repo: { node_id: repoId(repository), full_name: repository },
    },
    base: { sha: baseSha, ref: 'main', repo: { node_id: repoId(repository), full_name: repository } },
    user: { login: 'fixture-author' },
  });
  const issueInput = (number: number, kind: JournalInput['kind'], pending = false): JournalInput => {
    const common = {
      issueNumber: number,
      summary: 'Synthetic current work.',
      status: 'In Progress',
      nextStep: 'Continue',
      nextDate: null,
      keyNumbers: [],
      evidence: ['https://github.com/example/alpha/issues/1'],
    };
    switch (kind) {
      case 'progress':
        return { ...common, kind, done: ['Prepared'], decisionNeeded: pending ? 'Approve synthetic design' : 'None' };
      case 'decision':
        return { ...common, kind, decision: 'Selected approach', rationale: 'Reviewed' };
      case 'start':
        return { ...common, kind, outcome: 'Finish work' };
      case 'blocker':
        return { ...common, kind, blocker: 'Dependency', resolution: 'Wait for source' };
      case 'closeout':
        return {
          ...common,
          kind,
          acceptance: [{ criterion: 'Synthetic complete', evidence: 'https://github.com/example/alpha/issues/1' }],
          followUps: [],
        };
    }
  };
  const journal = (repository: string, number: number, input: JournalInput, id: string, createdAt = iso(-day)) => {
    const fullId = (BigInt(id) + BigInt(index(repository)) * 100000n).toString();
    return {
      id: `COMMENT-${fullId}`,
      fullDatabaseId: BigInt(fullId) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fullId) : fullId,
      createdAt,
      lastEditedAt: null as string | null,
      url: `https://github.com/${repository}/issues/${number}#issuecomment-${fullId}`,
      body: renderJournal(input, `<!-- ai-delivery:journal@1:${digestValue(input)} -->`),
    };
  };
  const comments = (repository: string, number: number) => {
    if (number === 21 || number === 22) {
      const firstId = 9007199254740992n + BigInt(number - 21) * 4n;
      const older = journal(repository, number, issueInput(number, 'progress', true), firstId.toString());
      const newer = journal(repository, number, issueInput(number, 'decision'), (firstId + 1n).toString());
      older.id = `OPAQUE-Z-${index(repository)}-${number}`;
      newer.id = `OPAQUE-A-${index(repository)}-${number}`;
      older.lastEditedAt = iso(-1000);
      return number === 21 ? [older, newer] : [newer, older];
    }
    const kind =
      number === 5
        ? 'decision'
        : number === 23
          ? 'start'
          : number === 24
            ? 'blocker'
            : number === 25
              ? 'closeout'
              : 'progress';
    const input = issueInput(number, kind, number <= 4);
    if (options.ambiguousJournal && index(repository) === 0 && number === 1)
      Object.assign(input, { details: '**Decision needed:** None' });
    return [
      journal(repository, number, issueInput(number, 'progress', true), `${1000 + number}`, iso(-2 * day)),
      journal(repository, number, input, `${2000 + number}`),
    ];
  };
  type ProjectReplayItem = {
    id: string;
    isArchived: boolean;
    content:
      | { __typename: 'Issue'; id: string; number: number; repository: { nameWithOwner: string } }
      | { __typename: 'DraftIssue' | 'PullRequest'; id: string };
    fieldValueByName: { name: string; optionId: string } | null;
  };
  const projectItems: ProjectReplayItem[] = Array.from({ length: 580 }, (_, i) => {
    const repository = i < 25 ? repos[0]! : i < 50 ? repos[1]! : 'example/unselected';
    const number = i < 50 ? (i % 25) + 1 : i + 1;
    const active = number >= 6 && number <= 10 && i < 50;
    return {
      id: `ITEM-${i}`,
      isArchived: false,
      content: {
        __typename: 'Issue' as const,
        id: issueId(repository, number),
        number,
        repository: { nameWithOwner: repository },
      },
      fieldValueByName: { name: active ? 'Active' : 'Queued', optionId: active ? 'STATUS-1' : 'STATUS-0' } as {
        name: string;
        optionId: string;
      } | null,
    };
  });
  projectItems[576] = { ...projectItems[5]!, id: 'ARCHIVED-SELECTED-ISSUE', isArchived: true };
  projectItems[577]!.content = { __typename: 'DraftIssue', id: 'DRAFT' };
  projectItems[578]!.content = { __typename: 'PullRequest', id: 'PROJECT-PR' };
  if (options.status === 'missing') projectItems[5]!.fieldValueByName = null;
  if (options.status === 'unsupported') projectItems[5]!.fieldValueByName = { name: 'Unknown', optionId: 'OTHER' };
  if (options.status === 'duplicate') projectItems[579] = { ...projectItems[5]!, id: 'DUPLICATE-ITEM' };
  const writer = (name: string) => async () => {
    calls.nativeWrites++;
    throw new Error(`Forbidden synthetic native writer: ${name}`);
  };
  const endpoint = (methods: Record<string, unknown>) =>
    new Proxy(methods, {
      get(target, property) {
        if (typeof property === 'string' && property in target) return target[property];
        if (typeof property !== 'string') return undefined;
        if (/^(?:create|update|delete|merge|add|remove|set|close|requestReview)/u.test(property))
          return writer(property);
        return async () => {
          calls.unexpectedReads++;
          throw new Error(`Unexpected synthetic read: ${property}`);
        };
      },
    });
  const coordinates = (input: Record<string, unknown>) => `${String(input.owner)}/${String(input.repo)}`.toLowerCase();
  const rest = {
    repos: endpoint({
      get: async (input: Record<string, unknown>) => {
        const repository = coordinates(input);
        count(`Repo:${repository}`);
        if (repository === repos[0]) options.abortAfterRepository?.abort();
        if (repository === options.unreadableRepository || index(repository) < 0) throw { status: 404 };
        return {
          status: 200,
          headers: {},
          data: { node_id: repoId(repository), full_name: repository, default_branch: 'main', private: false },
        };
      },
      getCombinedStatusForRef: async (input: Record<string, unknown>) => ({
        status: 200,
        headers: {},
        data: { sha: input.ref, state: 'success', total_count: 0, statuses: [] },
      }),
    }),
    issues: endpoint({
      listForRepo: async (input: Record<string, unknown>) => {
        const repository = coordinates(input);
        count(`Issues:${repository}`);
        const data =
          Number(input.page ?? 1) === 1
            ? [
                ...Array.from({ length: selectedCount(repository) }, (_, i) => observedIssue(repository, i + 1)),
                {
                  ...observedIssue(repository, 999),
                  pull_request: { url: `https://api.github.com/repos/${repository}/pulls/999` },
                },
              ]
            : [];
        return { status: 200, headers: {}, data };
      },
    }),
    pulls: endpoint({
      list: async (input: Record<string, unknown>) => {
        const repository = coordinates(input);
        count(`Prs:${repository}`);
        return {
          status: 200,
          headers: {},
          data:
            Number(input.page ?? 1) === 1 ? Array.from({ length: 10 }, (_, i) => observedPr(repository, 101 + i)) : [],
        };
      },
      get: async (input: Record<string, unknown>) => {
        const repository = coordinates(input);
        count(`Pr:${repository}`);
        return { status: 200, headers: {}, data: observedPr(repository, Number(input.pull_number)) };
      },
    }),
    checks: endpoint({
      listForRef: async (input: Record<string, unknown>) => ({
        status: 200,
        headers: {},
        data: {
          total_count: 1,
          check_runs: [
            {
              id: 10000 + Number.parseInt(String(input.ref).slice(-6), 16),
              name: 'checks',
              head_sha: input.ref,
              app: { id: 7 },
              status: 'completed',
              conclusion:
                options.prChecksFailed && coordinates(input) === repos[0] && input.ref === sha(101)
                  ? 'failure'
                  : 'success',
            },
          ],
        },
      }),
    }),
    git: endpoint({
      getRef: async (input: Record<string, unknown>) => {
        assert.equal(input.ref, 'heads/main');
        return {
          status: 200,
          headers: {},
          data: {
            ref: 'refs/heads/main',
            object: {
              type: 'commit',
              sha: options.movedBase && coordinates(input) === repos[0] ? 'd'.repeat(40) : baseSha,
            },
          },
        };
      },
    }),
    request: async (route: string) => {
      if (!route.startsWith('GET ')) return writer(route)();
      if (route.endsWith('/rules/branches/{branch}'))
        return {
          status: 200,
          headers: {},
          data: [
            {
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'checks', integration_id: 7 }] },
            },
          ],
        };
      if (route.endsWith('/protection')) return { status: 200, headers: {}, data: { required_status_checks: null } };
      calls.unexpectedReads++;
      throw new Error('Unexpected synthetic REST route.');
    },
  };
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    if (!query.trimStart().startsWith('query')) return writer('graphql')();
    const operation = /\bquery\s+(\w+)/u.exec(query)?.[1] ?? 'Unnamed';
    count(operation);
    const repository = `${String(variables.owner)}/${String(variables.repo ?? variables.name)}`.toLowerCase();
    if (operation === 'ProjectDeliveryConfiguration') {
      const data = await syntheticDiscoveryClients(native(repos[0]!)).graphql<{
        organization: { projectV2: { viewerCanUpdate: boolean } };
      }>(query, variables);
      if (options.readOnlyProject) data.organization.projectV2.viewerCanUpdate = false;
      return data;
    }
    if (operation === 'ProjectDeliveryItems') {
      const cursor = variables.cursor === null || variables.cursor === undefined ? 0 : Number(variables.cursor);
      const end = Math.min(cursor + 100, projectItems.length);
      return {
        organization: {
          projectV2: {
            id: 'PROJECT-1',
            number: 1,
            items: {
              nodes: projectItems.slice(cursor, end),
              pageInfo: {
                hasNextPage: end < projectItems.length,
                endCursor: options.projectCursorRepeats ? '100' : String(end),
              },
            },
          },
        },
      };
    }
    if (operation === 'DeliveryBoardJournal') {
      const number = Number(variables.number);
      if (options.journalDenied && index(repository) === 0 && number === 1) throw { status: 403 };
      assert.match(query, /comments\s*\(\s*last:\s*100\s*,\s*before:/u);
      const backwards =
        index(repository) === 0 && number === 1 && (options.journalBackwards || options.journalCursorRepeats);
      const skip = Boolean(
        backwards && (options.journalCursorRepeats || variables.cursor === null || variables.cursor === undefined),
      );
      const nodes = skip
        ? [
            {
              ...journal(repository, number, issueInput(number, 'progress'), '4001', iso(-1000)),
              body: 'Ordinary prose mentions ai-delivery:journal@1 without a comment marker.',
            },
          ]
        : comments(repository, number);
      return {
        repository: {
          id: repoId(repository),
          nameWithOwner: repository,
          issue: {
            id:
              options.wrongJournalParent && index(repository) === 0 && number === 1
                ? 'WRONG-PARENT'
                : issueId(repository, number),
            number,
            comments: { nodes, pageInfo: { hasPreviousPage: skip, startCursor: skip ? 'older' : null } },
          },
        },
      };
    }
    if (operation === 'DeliveryReviewDecision') {
      if (options.prReviewUnavailable && index(repository) === 0 && variables.number === 101) throw { status: 503 };
      return {
        repository: {
          pullRequest: {
            headRefOid: observedPr(repository, Number(variables.number)).head.sha,
            reviewDecision: Number(variables.number) <= 105 ? null : 'REVIEW_REQUIRED',
          },
        },
      };
    }
    if (operation === 'DeliveryBoardPr') {
      if (options.prNativeUnavailable && index(repository) === 0 && variables.number === 101) throw { status: 503 };
      const pr = observedPr(repository, Number(variables.number));
      const issueNumber = pr.number - 90;
      return {
        repository: {
          id: repoId(repository),
          nameWithOwner: repository,
          pullRequest: {
            id: pr.node_id,
            number: pr.number,
            state: 'OPEN',
            isDraft: false,
            headRefOid: pr.head.sha,
            baseRefOid: baseSha,
            headRefName: pr.head.ref,
            baseRefName: 'main',
            baseRepository: { id: repoId(repository), nameWithOwner: repository },
            headRepository: { id: repoId(repository), nameWithOwner: repository },
            mergeable: 'MERGEABLE',
            mergeStateStatus: pr.number <= 105 ? 'CLEAN' : 'BLOCKED',
            closingIssuesReferences: {
              nodes: [
                {
                  __typename: 'Issue',
                  id: issueId(repository, issueNumber),
                  number: issueNumber,
                  repository: { id: repoId(repository), nameWithOwner: repository },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    }
    if (operation === 'DeliveryBoardSearch') {
      assert.equal('query' in variables, false, 'Octokit reserves query; search variables use q');
      assert.match(query, /\$q:\s*String!/u);
      const search = String(variables.query ?? variables.q);
      const selectedRepo = /\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/u.exec(search)?.[1]?.toLowerCase();
      assert.ok(selectedRepo && index(selectedRepo) >= 0);
      assert.match(search, /\bis:pr\b/u);
      const merged = /\bmerged:/u.test(search);
      assert.match(search, merged ? /merged:>=/u : /created:>=/u);
      const qualifier = merged ? 'merged' : 'created';
      const lower = new RegExp(`${qualifier}:>=([^ ]+)`, 'u').exec(search)?.[1];
      const upper = new RegExp(`${qualifier}:<([^ ]+)`, 'u').exec(search)?.[1];
      assert.ok(lower && upper, 'both native timestamp bounds are explicit');
      const from = Date.parse(lower),
        to = Date.parse(upper);
      assert.ok(Number.isFinite(from) && Number.isFinite(to));
      assert.ok(from <= asOf - 7 * day && from > asOf - 7 * day - 1000, 'query lower bound encloses the exact window');
      assert.ok(to >= asOf && to < asOf + 1000, 'query upper bound preserves the final partial second');

      if (options.lateMetricFailure && selectedRepo === repos[1] && merged) throw { status: 503 };
      const marker = '<!-- ai-delivery:pr@1 -->';
      const nodes = options.emptyMetrics
        ? []
        : Array.from({ length: 3 }, (_, i) => ({
            __typename: 'PullRequest',
            id: `METRIC-${selectedRepo}-${merged ? 'merged' : 'opened'}-${i}`,
            number: 401 + i,
            url: `https://github.com/${selectedRepo}/pull/${401 + i}`,
            repository: { id: repoId(selectedRepo), nameWithOwner: selectedRepo },
            createdAt: merged
              ? iso(-30 * day)
              : options.windowEdges && selectedRepo === repos[0]
                ? iso(i === 0 ? -7 * day : i === 1 ? 0 : -7 * day - 1)
                : iso(-day),
            mergedAt: merged
              ? options.windowEdges && selectedRepo === repos[0]
                ? iso(i === 0 ? -7 * day : i === 1 ? 0 : -1)
                : iso(-day)
              : null,
            body: i < 2 ? `Synthetic proof.\n\n${marker}` : 'Unmarked body.',
            mergeCommit: merged
              ? options.unknownMergeCommit && selectedRepo === repos[0] && i === 0
                ? null
                : {
                    oid: sha(401 + i),
                    message:
                      i === 0 ? 'Synthetic squash\n\nDelivered-by: ai-delivery\n' : 'Historical merge, unmarked.',
                  }
              : null,
          }));
      if (options.duplicateSearchIds && selectedRepo === repos[0] && !merged) nodes[1] = { ...nodes[0]! };
      if (options.retainedLimit && selectedRepo === repos[0] && !merged && nodes[0])
        nodes[0].id = 'x'.repeat(16 * 1024 * 1024);
      return {
        search: {
          issueCount: options.searchCap && selectedRepo === repos[0] && !merged ? 1001 : nodes.length,
          nodes,
          pageInfo: {
            hasNextPage: Boolean(options.searchCursorRepeats && selectedRepo === repos[0] && !merged),
            endCursor: options.searchCursorRepeats && selectedRepo === repos[0] && !merged ? 'repeated' : null,
          },
        },
      };
    }
    calls.unexpectedReads++;
    throw new Error(`Unexpected synthetic GraphQL read ${operation}`);
  };
  const clients = {
    rest,
    graphql,
    authSource: 'personal',
    role: 'author',
    credentialSource: 'synthetic-principal',
    authenticatedAuthor: async () => ({ actorLogin: 'fixture-author', credentialIdentity: 'synthetic-principal' }),
  } as unknown as DeliveryContext['clients'];
  const context = (repository: string): DeliveryContext => {
    const cfg = configs.get(repository)!;
    const routing: DeliveryRouting = {
      repository,
      repositoryId: repoId(repository),
      projectId: 'PROJECT-1',
      projectSource: 'explicit',
      statusFieldId: 'STATUS-FIELD',
      statusOptionIds: { Todo: 'STATUS-0', 'In Progress': 'STATUS-1', Blocked: 'STATUS-2', Done: 'STATUS-3' },
      pointsFieldId: 'PROJECT-FIELD-101',
      priorityFieldId: 'PROJECT-FIELD-102',
      native: cfg.native,
    };
    const loaded: LoadedGitHubConfig = {
      config: cfg,
      configDigest: digestValue({ sourceDigest: settings.sourceDigest, routing, roles: cfg.roles }),
      configPath: settings.configPath,
      routing,
    };
    const selectedClients =
      index(repository) === 1 && options.contextPrincipal
        ? {
            ...clients,
            authenticatedAuthor: async () => {
              if (options.contextPrincipal === 'unavailable') throw { status: 503 };
              return { actorLogin: 'different-author', credentialIdentity: 'different-principal' };
            },
          }
        : clients;
    if (options.contextIdentityMismatch && index(repository) === 1) loaded.routing.repositoryId = 'WRONG-REPOSITORY';
    return {
      clients: selectedClients,
      repo: { owner: 'example', repo: repository.split('/')[1]! },
      root: '',
      config: cfg,
      configuration: loaded,
    };
  };
  for (const [i, root] of roots.entries()) {
    mkdirSync(root, { recursive: true });
    fixtureGit(root, 'init', '-b', 'main');
    fixtureGit(root, 'config', 'remote.origin.url', `https://github.com/${repos[i]}.git`);
    writeFileSync(
      join(root, 'consumer-trap.cjs'),
      `require('node:fs').appendFileSync(${JSON.stringify(trap)}, 'executed\\n');process.exit(91);\n`,
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node consumer-trap.cjs', preinstall: 'node consumer-trap.cjs' } }),
    );
    fixtureGit(root, 'add', '.');
    fixtureGit(root, 'commit', '-m', 'Synthetic inert target');
    configHashes.set(root, snapshot(join(root, '.git', 'config')));
  }
  vi.spyOn(configuration, 'loadDeliverySettings').mockResolvedValue(settings);
  vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockImplementation(async (input) => {
    input.signal?.throwIfAborted();
    calls.clientFactory++;
    assert.equal(input.role, 'author');
    assert.equal(input.identity, settings.roles.author.identity);
    assert.deepEqual(input.config.roles, settings.roles);
    assert.equal(input.personalAuth, undefined, 'no actor fallback in the configured-author replay');
    return clients;
  });
  vi.spyOn(issueOwner, 'loadDeliveryContext').mockImplementation(async (input) => {
    input.signal?.throwIfAborted();
    calls.contexts++;
    assert.equal(input.role, 'author');
    assert.equal(input.identity, settings.roles.author.identity);
    assert.deepEqual(input.settings?.roles, settings.roles);
    assert.deepEqual(input.settings?.overrides, settings.overrides);
    assert.equal(input.settings?.sourceDigest, settings.sourceDigest);
    assert.equal(input.settings?.configPath, settings.configPath);
    assert.notEqual(input.personalAuth, true, 'no actor fallback during context discovery');
    if (options.projectDenied) throw { status: 403 };
    if (options.readOnlyProject)
      assert.equal(input.requireWritableProject, false, 'read-only Project discovery needs no write permission');
    assert.ok(input.repository && index(input.repository) >= 0);
    return context(input.repository);
  });
  vi.spyOn(projectOwner, 'getIssueProjectStatus').mockImplementation(async () => {
    calls.perItemStatusReads++;
    throw new Error('Per-item Project lookup forbidden');
  });
  const execution: ExecutionContext = { settings, repoRoot: base };
  const assertReadOnly = () => {
    assert.equal(calls.nativeWrites, 0);
    assert.equal(calls.setupCalls, 0);
    assert.equal(calls.perItemStatusReads, 0);
    assert.equal(calls.unexpectedReads, 0);
    assert.equal(existsSync(trap), false);
    for (const [root, original] of configHashes)
      assert.deepEqual(snapshot(join(root, '.git', 'config')), original, 'checkout configuration remains unchanged');
  };
  return { base, roots, repos, calls, settings, execution, assertReadOnly, dispose };
}
