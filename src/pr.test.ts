import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWorktreeEntry, listWorktreesStrict } from './services/worktreeRegistry.js';
import { describe, it } from 'vitest';
import { publishPr, mergePr, finishIssue, prChecks, queueChecks, queuePr } from './pr.js';
import type { DeliveryContext } from './issue.js';
import { digestValue } from './delivery/common.js';
import { recordedBaseDrift, recordedZeroApproval } from './fixtures/recordedGitHubFlows.js';
import * as prReaders from './pr.js';

it('markers require their exact canonical footer/trailer', () => {
  const bodyMarker = Reflect.get(prReaders, 'hasDeliveryPrMarker') as ((body: string) => boolean) | undefined;
  const trailer = Reflect.get(prReaders, 'hasDeliveryMergeTrailer') as ((body: string) => boolean) | undefined;
  assert.equal(typeof bodyMarker, 'function');
  assert.equal(typeof trailer, 'function');
  const marker = '<!-- ai-delivery:pr@1 -->';
  assert.equal(bodyMarker!(`Closes #17\n\nProof.\n\n${marker}`), true);
  assert.equal(bodyMarker!(`Closes #17\n\nDocument ai-delivery:pr@1 semantics.\n\n${marker}`), true);
  assert.equal(bodyMarker!(`Proof\n\n\`\`\`md\n${marker}\n\`\`\`\n\n${marker}`), true);
  assert.equal(bodyMarker!(`Proof\n\n> ${marker}\n\n${marker}`), true);
  for (const example of [
    `Proof\n\n    ${marker}`,
    `Proof\n\n\t${marker}`,
    `Proof\n\n~~~md\n${marker}\n~~~`,
    `Proof \`multiline\n    text ${marker}\ntext\`.`,
    `Escaped \\${marker} remains literal.`,
    `The literal marker is \`${marker}\`.`,
    `The literal marker is \`\`before \` ${marker}\`\`.`,
    `Example \`multiline\ntext ${marker}\ntext\`.`,
    'An unmatched backtick is literal: `',
  ])
    assert.equal(bodyMarker!(`Closes #17\n\n${example}\n\n${marker}`), true, example);
  assert.equal(bodyMarker!(`Closes #17\n\nEscaped \\\`${marker} remains active.\n\n${marker}`), false);
  for (const indent of ['', ' ', '  ', '   '])
    assert.equal(
      bodyMarker!(`Closes #17\n\nExample \`multiline\n${indent}${marker}\ntext\`.\n\n${marker}`),
      false,
      'A comment block interrupts the paragraph before inline code parsing',
    );
  for (const boundary of ['=', '--', '___'])
    assert.equal(bodyMarker!(`Proof \`open\n${boundary}\ntext ${marker}\nclose\`.\n\n${marker}`), false);
  for (const body of [
    `Proof\n\n<div>\n\`\`\`\n${marker}\n\`\`\`\n</div>\n\n${marker}`,
    `Proof\n\n<?instruction\n\n${marker}`,
    `Proof\n\n<![CDATA[\n\n${marker}`,
    `Proof \`multiline\n# Heading\ntext ${marker}\ntext\`.\n\n${marker}`,
    `Proof \`multiline\n- New block\ntext ${marker}\ntext\`.\n\n${marker}`,
    `Proof\n\n\`\`\`\`\n${marker}\n\`\`\`\n\n${marker}`,
    `Proof\n\n\`\`\`\n${marker}\n~~~\n\n${marker}`,
    `Proof\n\n<!-- outer comment\n\n${marker}`,
    `Proof\n\n<pre>\n\n${marker}`,
    `Proof\n    ${marker}\n\n${marker}`,
    `Proof\n\n- Container\n    ${marker}\n\n${marker}`,
    marker,
    `Proof\n${marker}`,
    `Proof\n\n> ${marker}`,
    `Proof\n\n\`\`\`\n${marker}\n\`\`\``,
    `Proof\n\n${marker}\nextra`,
    `Proof\n\n${marker}\n\n${marker}`,
    `Proof\n\n${marker}\n`,
  ])
    assert.equal(bodyMarker!(body), false, body);
  for (const message of ['Title\n\nDelivered-by: ai-delivery', 'Title\n\nDelivered-by: ai-delivery\n'])
    assert.equal(trailer!(message), true);
  assert.equal(trailer!('Document Delivered-by: ai-delivery in the guide\n\nDelivered-by: ai-delivery'), true);
  assert.equal(trailer!('Document `multiline\nDelivered-by: ai-delivery\nexample`\n\nDelivered-by: ai-delivery'), true);
  for (const message of [
    'Delivered-by: ai-delivery\nextra',
    'Title\n\n> Delivered-by: ai-delivery',
    'Title\n\n```\nDelivered-by: ai-delivery\n```',
    'Title\n\nDelivered-by: ai-delivery\n\nDelivered-by: ai-delivery',
    'Title\n\nDelivered-by: other',
  ])
    assert.equal(trailer!(message), false, message);
});

type BoardTestFacts = {
  ready: boolean;
  reasons: string[];
  review: { observed?: boolean; reviewDecision: unknown };
  checks: { state: string; complete: boolean; proof?: Array<{ name: string; appId: number | null; id: number }> };
  closingLinks: { complete: boolean };
  headRepository: { name: string; id: string };
};
async function boardFacts(context: DeliveryContext) {
  const read = Reflect.get(prReaders, 'readPrBoardFacts') as
    | ((context: Pick<DeliveryContext, 'clients' | 'repo'>, number: number) => Promise<BoardTestFacts>)
    | undefined;
  assert.equal(typeof read, 'function', 'read-only PR board facts are available');
  return read!({ clients: context.clients, repo: context.repo }, 23);
}
function boardFixture(
  option: {
    decision?: unknown;
    missingDecision?: boolean;
    unavailableReview?: boolean;
    reviewHeadMoved?: boolean;
    nativeState?: string;
    draft?: boolean;
    mergeable?: string;
    drift?: 'head' | 'base' | 'body';
    baseMoved?: boolean;
    nonClosing?: boolean;
    fork?: boolean;
    headRef?: string;
    baseRef?: string;
    linksIncomplete?: boolean;
    check?: 'none' | 'missing' | 'foreign' | 'pending' | 'failed' | 'truncated' | 'requirements-unknown';
  } = {},
) {
  const { context } = fixture();
  // Synthetic eligible transition over recorded zero-required-approval native facts.
  // The source capture is draft; this fixture explicitly changes it to ready/CLEAN.
  const projection = recordedZeroApproval.repository.pullRequest;
  const head: string = projection.headRefOid;
  const base: string = projection.baseRefOid;
  const headRef = option.headRef ?? 'issue/17';
  const baseRef = option.baseRef ?? 'main';
  const calls: string[] = [];
  let reads = 0;
  const repository = { id: 'REPO', nameWithOwner: 'example/widget' };
  const headRepository = option.fork ? { id: 'FORK', nameWithOwner: 'contributor/widget' } : repository;
  const pr = () => ({
    number: 23,
    node_id: 'PR23',
    html_url: 'https://github.com/example/widget/pull/23',
    title: 'Improve widget',
    body: option.nonClosing ? 'References example/widget#17\n\nProof.' : 'Closes #17\n\nProof.',
    state: 'open',
    merged: false,
    draft: option.draft ?? false,
    mergeable: option.mergeable !== 'CONFLICTING',
    mergeable_state: 'clean',
    head: { sha: head, ref: headRef, repo: { node_id: headRepository.id, full_name: headRepository.nameWithOwner } },
    base: { sha: base, ref: baseRef, repo: { node_id: repository.id, full_name: repository.nameWithOwner } },
  });
  const run = { id: 10, name: 'checks', head_sha: head, app: { id: 7 }, status: 'completed', conclusion: 'success' };
  context.clients.rest = {
    request: async (route: string) => {
      calls.push(route);
      assert.ok(route.startsWith('GET '), 'no native writes');
      if (option.check === 'requirements-unknown') throw { status: 403 };
      if (route.endsWith('/rules/branches/{branch}'))
        return {
          status: 200,
          headers: {},
          data:
            option.check === 'none'
              ? []
              : [
                  {
                    type: 'required_status_checks',
                    parameters: { required_status_checks: [{ context: 'checks', integration_id: 7 }] },
                  },
                ],
        };
      assert.ok(route.endsWith('/protection'));
      return { status: 200, headers: {}, data: { required_status_checks: null } };
    },
    pulls: {
      get: async () => {
        calls.push('pulls.get');
        const result = pr();
        if (++reads > 1) {
          if (option.drift === 'head') result.head.sha = 'f'.repeat(40);
          if (option.drift === 'base') result.base.sha = 'e'.repeat(40);
          if (option.drift === 'body') result.body += '\nChanged';
        }
        return { data: result };
      },
    },
    checks: {
      listForRef: async () => {
        calls.push('checks.listForRef');
        const check_runs =
          option.check === 'missing'
            ? []
            : option.check === 'foreign'
              ? [{ ...run, app: { id: 8 } }]
              : option.check === 'pending'
                ? [run, { ...run, id: 11, status: 'in_progress', conclusion: null }]
                : option.check === 'failed'
                  ? [{ ...run, conclusion: 'failure' }]
                  : [run];
        return {
          status: 200,
          headers: option.check === 'truncated' ? { link: 'next' } : {},
          data: { total_count: check_runs.length, check_runs },
        };
      },
    },
    repos: {
      getCombinedStatusForRef: async () => {
        calls.push('repos.getCombinedStatusForRef');
        return { status: 200, headers: {}, data: { sha: head, total_count: 0, statuses: [] } };
      },
    },
    git: {
      getRef: async ({ ref }: { ref: string }) => {
        calls.push('git.getRef');
        assert.equal(ref, `heads/${baseRef}`);
        return {
          data: {
            ref: `refs/heads/${baseRef}`,
            object: { type: 'commit', sha: option.baseMoved ? 'd'.repeat(40) : base },
          },
        };
      },
    },
  } as unknown as DeliveryContext['clients']['rest'];
  context.clients.graphql = (async (query: string) => {
    assert.ok(query.trimStart().startsWith('query'), 'no GraphQL writes');
    if (query.includes('DeliveryReviewDecision')) {
      calls.push('DeliveryReviewDecision');
      if (option.unavailableReview) throw { status: 403 };
      return {
        repository: {
          pullRequest: {
            headRefOid: option.reviewHeadMoved ? '0'.repeat(40) : head,
            ...(option.missingDecision
              ? {}
              : { reviewDecision: Object.hasOwn(option, 'decision') ? option.decision : null }),
          },
        },
      };
    }
    assert.ok(query.includes('DeliveryBoardPr'), 'no extra review counts, approval or mutation queries');
    calls.push('DeliveryBoardPr');
    return {
      repository: {
        ...repository,
        pullRequest: {
          id: 'PR23',
          number: 23,
          state: 'OPEN',
          isDraft: option.draft ?? false,
          headRefOid: head,
          baseRefOid: base,
          headRefName: headRef,
          baseRefName: baseRef,
          baseRepository: repository,
          headRepository,
          mergeable: option.mergeable ?? 'MERGEABLE',
          mergeStateStatus: option.nativeState ?? 'CLEAN',
          closingIssuesReferences: {
            nodes: option.nonClosing ? [] : [{ __typename: 'Issue', id: 'ISSUE17', number: 17, repository }],
            pageInfo: { hasNextPage: option.linksIncomplete ?? false, endCursor: null },
          },
        },
      },
    };
  }) as DeliveryContext['clients']['graphql'];
  return { context, calls, head, base };
}
it('board accepts observed null with native CLEAN eligibility', async () => {
  for (const option of [
    {},
    { decision: 'APPROVED' },
    { check: 'none' as const },
    { fork: true },
    { fork: true, headRef: 'fix/café' },
    { headRef: 'fix/$work', baseRef: 'release/été' },
  ]) {
    const f = boardFixture(option);
    const result = await boardFacts(f.context);
    assert.equal(result.ready, true, JSON.stringify(option));
    assert.equal(result.review.observed, true);
    assert.equal(result.review.reviewDecision, option.decision ?? null);
    assert.equal(result.checks.state, 'passed');
    assert.equal(result.closingLinks.complete, true);
    assert.equal(result.headRepository.name, option.fork ? 'contributor/widget' : 'example/widget');
    assert.equal(f.calls.filter((x) => x === 'DeliveryReviewDecision').length, 1);
    if (option.check === 'none') {
      assert.equal(f.calls.filter((x) => x === 'checks.listForRef').length, 0);
      assert.equal(
        (await queueChecks(f.context, 'main', f.head)).state,
        'waiting',
        'queue still requires actual checks',
      );
    }
  }
});
it('board distinguishes unavailable review from explicit null', async () => {
  for (const option of [
    { unavailableReview: true },
    { missingDecision: true },
    { decision: 'malformed' },
    { reviewHeadMoved: true },
    { decision: 'REVIEW_REQUIRED' },
    { decision: 'CHANGES_REQUESTED' },
    { nativeState: 'UNKNOWN' },
    { draft: true },
    { mergeable: 'UNKNOWN' },
    { mergeable: 'CONFLICTING' },
    { nonClosing: true },
    { linksIncomplete: true },
  ]) {
    const result = await boardFacts(boardFixture(option).context);
    assert.equal(result.ready, false, JSON.stringify(option));
    assert.ok(result.reasons.length > 0);
    if (option.unavailableReview || option.missingDecision || option.decision === 'malformed' || option.reviewHeadMoved)
      assert.equal(result.review.observed, false);
  }
});
it('board retains required App producer and current base proof', async () => {
  const ready = await boardFacts(boardFixture().context);
  assert.deepEqual(ready.checks.proof, [{ name: 'checks', appId: 7, id: 10 }]);
  for (const option of [
    ...(['missing', 'foreign', 'pending', 'failed', 'truncated', 'requirements-unknown'] as const).map((check) => ({
      check,
    })),
    ...(['head', 'base', 'body'] as const).map((drift) => ({ drift })),
    { baseMoved: true },
  ]) {
    const result = await boardFacts(boardFixture(option).context);
    assert.equal(result.ready, false, JSON.stringify(option));
    assert.ok(result.reasons.length > 0);
  }
});

const head = 'a'.repeat(40);
const merge = 'b'.repeat(40);

for (const mode of [
  'complete',
  'generic-404',
  'forbidden',
  'unreadable-repository',
  'wrong-repository',
  'no-write',
  'wrong-branch',
  'missing-summary',
  'partial-rules',
  'partial-rulesets',
  'mismatched-ruleset',
  'inactive-ruleset',
  'wrong-source',
]) {
  it(`queue discovers ruleset-only required checks with ${mode} visibility`, async () => {
    const { context } = fixture();
    const rule = {
      type: 'required_status_checks',
      ruleset_id: 41,
      ruleset_source_type: 'Repository',
      ruleset_source: mode === 'wrong-source' ? 'elsewhere/widget' : 'example/widget',
      parameters: { required_status_checks: [{ context: 'checks', integration_id: 7 }] },
    };
    Object.assign(context.clients.rest, {
      request: async (route: string) => {
        if (route.endsWith('/protection'))
          throw mode === 'generic-404'
            ? { status: 404 }
            : mode === 'forbidden'
              ? { status: 403 }
              : { status: 404, response: { status: 404, data: { message: 'Branch not protected' } } };
        if (route.includes('/rules/branches/'))
          return { status: 200, headers: mode === 'partial-rules' ? { link: 'next' } : {}, data: [rule] };
        if (route.endsWith('/rulesets'))
          return {
            status: 200,
            headers: mode === 'partial-rulesets' ? { link: 'next' } : {},
            data: [
              {
                id: mode === 'mismatched-ruleset' ? 42 : 41,
                source_type: 'Repository',
                source: 'example/widget',
                enforcement: mode === 'inactive-ruleset' ? 'disabled' : 'active',
              },
            ],
          };
        if (route.endsWith('/branches/{branch}'))
          return {
            status: 200,
            data: {
              name: mode === 'wrong-branch' ? 'other' : 'main',
              protected: true,
              ...(mode === 'missing-summary' ? {} : { protection: { enabled: false } }),
            },
          };
        if (mode === 'unreadable-repository') throw { status: 403 };
        return {
          status: 200,
          data: {
            full_name: mode === 'wrong-repository' ? 'elsewhere/widget' : 'example/widget',
            permissions: { push: mode !== 'no-write' },
          },
        };
      },
    });
    const reads: string[] = [];
    let appId = 7,
      checkSha = head;
    Object.assign(context.clients.rest.checks, {
      listForRef: async ({ ref }: { ref: string }) => {
        reads.push(ref);
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [
              {
                id: 10,
                name: 'checks',
                head_sha: checkSha,
                app: { id: appId },
                status: 'completed',
                conclusion: 'success',
              },
            ],
          },
        };
      },
    });
    Object.assign(context.clients.rest.repos, {
      getCombinedStatusForRef: async () => ({
        status: 200,
        headers: {},
        data: { sha: head, total_count: 0, statuses: [] },
      }),
    });
    const result = await queueChecks(context, 'main', head);
    if (mode !== 'complete') {
      assert.equal(result.state, 'waiting');
      assert.deepEqual(reads, []);
    } else {
      assert.equal(result.state, 'passed');
      assert.deepEqual(reads, [head]);
      assert.deepEqual(result.proof, [{ name: 'checks', appId: 7, id: 10 }]);
      appId = 8;
      assert.equal((await queueChecks(context, 'main', head)).state, 'waiting');
      appId = 7;
      checkSha = 'e'.repeat(40);
      assert.equal((await queueChecks(context, 'main', head)).state, 'waiting');
    }
  });
}

for (const appId of [null, 7]) {
  for (const state of ['success', 'failure', 'error', 'pending', 'unknown']) {
    it(`queue evaluates a same-name ${state} status alongside a successful ${appId === null ? 'wildcard' : 'App-pinned'} run`, async () => {
      const { context } = fixture();
      Object.assign(context.clients.rest, {
        request: async (route: string) => ({
          status: 200,
          headers: {},
          data: route.endsWith('/protection')
            ? { required_status_checks: { checks: [{ context: 'checks', app_id: appId }] } }
            : [],
        }),
      });
      Object.assign(context.clients.rest.checks, {
        listForRef: async () => ({
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [
              { id: 10, name: 'checks', head_sha: head, app: { id: 7 }, status: 'completed', conclusion: 'success' },
            ],
          },
        }),
      });
      Object.assign(context.clients.rest.repos, {
        getCombinedStatusForRef: async () => ({
          status: 200,
          headers: {},
          data: {
            sha: head,
            total_count: 1,
            statuses: [{ id: 20, context: 'checks', state, creator: { id: 7, login: 'checks[bot]' } }],
          },
        }),
      });
      const result = await queueChecks(context, 'main', head);
      assert.equal(
        result.state,
        appId !== null
          ? 'waiting'
          : state === 'success'
            ? 'passed'
            : ['failure', 'error'].includes(state)
              ? 'failed'
              : 'waiting',
      );
      if (appId !== null) assert.match(result.reason, /source/iu);
    });
  }
}

for (const mode of ['pagination', 'issue-type', 'pr-id']) {
  it(`queue issue derivation refuses incomplete or inconsistent native ${mode}`, async () => {
    const { context } = fixture();
    const original = context.clients.graphql;
    let first = true;
    Object.assign(context.clients, {
      graphql: async (query: string, variables: Record<string, unknown>) => {
        if (query.includes('DeliveryClosingIssues') && first) {
          first = false;
          return {
            repository: {
              nameWithOwner: 'example/widget',
              pullRequest: {
                id: mode === 'pr-id' ? 'OTHER' : 'PR23',
                number: 23,
                closingIssuesReferences: {
                  nodes: [
                    {
                      __typename: mode === 'issue-type' ? 'PullRequest' : 'Issue',
                      id: 'ISSUE',
                      number: 17,
                      repository: { id: 'REPO', nameWithOwner: 'example/widget' },
                    },
                  ],
                  pageInfo: mode === 'pagination' ? { endCursor: null } : { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        return original(query, variables);
      },
    });
    await assert.rejects(queuePr(context, 23), /complete|identity|issue/iu);
  });
}

it('preserves legacy required contexts alongside pinned checks and requires the latest exact-SHA source', async () => {
  const { context } = fixture();
  const check = {
    id: 10,
    name: 'pinned',
    head_sha: head,
    app: { id: 7 },
    status: 'completed',
    conclusion: 'success' as string | null,
  };
  let runs = [check];
  Object.assign(context.clients.rest, {
    request: async (route: string) => ({
      status: 200,
      headers: {},
      data: route.endsWith('/protection')
        ? { required_status_checks: { checks: [{ context: 'pinned', app_id: 7 }], contexts: ['pinned', 'legacy'] } }
        : [],
    }),
  });
  Object.assign(context.clients.rest.checks, {
    listForRef: async () => ({ status: 200, headers: {}, data: { total_count: runs.length, check_runs: runs } }),
  });
  Object.assign(context.clients.rest.repos, {
    getCombinedStatusForRef: async () => ({
      status: 200,
      headers: {},
      data: {
        sha: head,
        state: 'success',
        total_count: 1,
        statuses: [{ id: 20, context: 'legacy', state: 'success' }],
      },
    }),
  });
  assert.deepEqual(
    (await prChecks(context, 23)).requiredChecks.map((c) => c.name),
    ['legacy', 'pinned'],
  );
  assert.equal((await queueChecks(context, 'main', head)).state, 'passed');
  runs = [{ ...check, app: { id: 8 } }];
  assert.equal((await queueChecks(context, 'main', head)).state, 'waiting');
  runs = [check, { ...check, id: 11, status: 'in_progress', conclusion: null }];
  assert.equal((await queueChecks(context, 'main', head)).state, 'waiting');
  runs = [{ ...check, head_sha: 'e'.repeat(40) }];
  assert.equal((await queueChecks(context, 'main', head)).state, 'waiting');
});

it('queue guard retains native eligibility and records intent only after the last base/proof check', async () => {
  for (const state of ['behind', 'blocked']) {
    const f = fixture(state),
      stages: string[] = [];
    await assert.rejects(
      mergePr(
        f.context,
        { issueNumber: 17, prNumber: 23 },
        {
          expectedBase: 'c'.repeat(40),
          checkProof: async () => {
            stages.push('proof');
          },
          beforeMutation: async () => {
            stages.push('intent');
          },
        },
      ),
      /merge eligibility/u,
    );
    assert.deepEqual(stages, []);
    assert.equal(f.merges.length, 0);
  }
  const f = fixture(),
    stages: string[] = [];
  await assert.rejects(
    mergePr(
      f.context,
      { issueNumber: 17, prNumber: 23 },
      {
        expectedBase: 'c'.repeat(40),
        checkProof: async () => {
          stages.push('proof');
          const get = f.context.clients.rest.git.getRef;
          f.context.clients.rest.git.getRef = (async (input: { ref: string }) => {
            const result = await get(input as Parameters<typeof get>[0]);
            if (input.ref === 'heads/main') result.data.object.sha = 'd'.repeat(40);
            return result;
          }) as unknown as typeof get;
        },
        beforeMutation: async () => {
          stages.push('intent');
        },
      },
    ),
    /base moved/u,
  );
  assert.deepEqual(stages, ['proof']);
  assert.equal(f.merges.length, 0);
});

function fixture(
  state: string | null = 'clean',
  option: {
    headSha?: string;
    headTree?: string;
    mergeSha?: string;
    remoteBaseSha?: string;
    baseSha?: string;
    configuredRequiredChecks?: string[];
    requirementsViaClassic?: boolean;
    requirementsUnavailable?: boolean;
    nativeChecks?: Array<{ name: string; required: boolean; status: string; conclusion: string | null }>;
    nativeStatuses?: Array<{ name: string; required: boolean; state: string }>;
    baseMoved?: boolean;
    nonClosing?: boolean;
    commitMessage?: string;
    prBody?: string;
    messageChangedAfterDecision?: 'title' | 'body';
    retainedIssueDrift?: boolean;
    mergeAckLost?: boolean;
    headMoved?: boolean;
    reviewDecision?: unknown;
    decisionUnavailable?: boolean;
    decisionHeadMoved?: boolean;
    baseChangedAfterDecision?: 'name' | 'sha';
    unrelatedBranch?: boolean;
    failedClose?: boolean;
    deletedAfterMerge?: boolean;
    wrongClosingIssue?: boolean;
    reviewBinding?:
      | 'stale-head'
      | 'wrong-tree'
      | 'wrong-scope'
      | 'invalid-digest'
      | 'marker-only'
      | 'wrong-issue'
      | 'wrong-pr'
      | 'wrong-role';
  } = {},
) {
  const head = option.headSha ?? 'a'.repeat(40);
  const merge = option.mergeSha ?? 'b'.repeat(40);
  const base = option.baseSha ?? 'c'.repeat(40);
  let merged = false;
  let decisionRead = false;
  let closes = 0;
  let publicationBody: string | undefined;
  let publicationTitle: string | undefined;
  let publicationDraft: boolean | undefined;
  const merges: Record<string, unknown>[] = [];
  const artifactContent = {
    authorIdentity: option.reviewBinding === 'wrong-role' ? 'collaborator' : 'author',
    reviewerIdentity: 'reviewer',
    checks: ['retained checks'],
    diffScopeHash: digestValue([option.reviewBinding === 'wrong-scope' ? 'elsewhere.ts' : 'change.ts']),
    elapsedMs: 1,
    findings: [],
    head: {
      sha: option.reviewBinding === 'stale-head' ? 'e'.repeat(40) : head,
      tree: option.reviewBinding === 'wrong-tree' ? 'f'.repeat(40) : (option.headTree ?? '0'.repeat(40)),
    },
    issueNumber: option.reviewBinding === 'wrong-issue' ? 18 : 17,
    prNumber: option.reviewBinding === 'wrong-pr' ? 24 : 23,
    readOnly: true,
    requestedEffort: 'xhigh',
    requestedModel: 'gpt-6-astra',
    effectiveEffort: 'unknown',
    effectiveModel: 'unknown',
    schemaVersion: 'ai-delivery.review-artifact@1',
    summary: 'Independent review.',
    verdict: 'approve',
  };
  const artifact = {
    ...artifactContent,
    artifactId: option.reviewBinding === 'invalid-digest' ? `sha256:${'d'.repeat(64)}` : digestValue(artifactContent),
  };
  const marker = `<!-- ai-delivery-review-artifact: ${artifact.artifactId} -->`;
  const reviewBody =
    option.reviewBinding === 'marker-only'
      ? marker
      : `${artifact.summary}\n\n${marker}\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(artifact)).toString('base64url')} -->`;
  const pr = () => ({
    number: 23,
    node_id: 'PR23',
    changed_files: 1,
    title:
      decisionRead && option.messageChangedAfterDecision === 'title'
        ? 'Edited title'
        : (publicationTitle ?? 'Improve widget'),
    body:
      publicationBody ??
      (decisionRead && option.messageChangedAfterDecision === 'body' ? 'Closes #17\n\nEdited body.' : option.prBody) ??
      (option.nonClosing ? 'References example/widget#17\n\nImprove widget.' : 'Closes #17'),
    html_url: 'https://github.com/example/widget/pull/23',
    state: merged ? 'closed' : 'open',
    draft: publicationDraft ?? false,
    merged,
    merge_commit_sha: merged ? merge : null,
    mergeable: state === 'clean' || state === 'unstable' || state === 'has_hooks',
    mergeable_state: state,
    head: { sha: head, ref: 'issue/17', repo: { full_name: 'example/widget' } },
    base: {
      sha: decisionRead && option.baseChangedAfterDecision === 'sha' ? 'd'.repeat(40) : base,
      ref: decisionRead && option.baseChangedAfterDecision === 'name' ? 'other' : 'main',
      repo: { full_name: 'example/widget' },
    },
    user: { login: 'author' },
  });
  const rest = {
    request: async (route: string) => {
      if (option.requirementsUnavailable) throw { status: 403 };
      if (route.endsWith('/rules/branches/{branch}'))
        return {
          status: 200,
          headers: {},
          data: option.requirementsViaClassic
            ? []
            : [
                {
                  type: 'required_status_checks',
                  parameters: {
                    required_status_checks: (
                      option.configuredRequiredChecks ??
                      [
                        ...(option.nativeChecks ?? []).filter((check) => check.required),
                        ...(option.nativeStatuses ?? []).filter((check) => check.required),
                      ].map((check) => check.name)
                    ).map((context) => ({ context })),
                  },
                },
              ],
        };
      return {
        status: 200,
        headers: {},
        data: {
          required_pull_request_reviews: { required_approving_review_count: 0 },
          required_status_checks: option.requirementsViaClassic
            ? { contexts: option.configuredRequiredChecks ?? [] }
            : null,
        },
      };
    },
    checks: {
      listForRef: async () => ({
        data: {
          total_count: (option.nativeChecks ?? []).length,
          check_runs: (option.nativeChecks ?? []).slice(0, 100).map((check) => ({
            name: check.name,
            status: check.status.toLowerCase(),
            conclusion: check.conclusion?.toLowerCase() ?? null,
          })),
        },
      }),
    },
    repos: {
      getCombinedStatusForRef: async () => ({
        data: {
          state: (option.nativeStatuses ?? []).some((check) => ['FAILURE', 'ERROR'].includes(check.state))
            ? 'failure'
            : 'success',
          total_count: (option.nativeStatuses ?? []).length,
          statuses: (option.nativeStatuses ?? [])
            .slice(0, 100)
            .map((check) => ({ context: check.name, state: check.state.toLowerCase() })),
        },
      }),
      get: async () => ({ data: { node_id: 'REPO', default_branch: 'main', full_name: 'example/widget' } }),
    },
    git: {
      getCommit: async () => ({ data: { sha: head, tree: { sha: option.headTree ?? '0'.repeat(40) } } }),
      getRef: async ({ ref }: { ref: string }) => ({
        data: {
          ref: `refs/${ref}`,
          object: {
            type: 'commit',
            sha:
              ref === 'heads/main' || ref === 'heads/other'
                ? option.baseMoved
                  ? 'e'.repeat(40)
                  : merged
                    ? (option.remoteBaseSha ?? base)
                    : base
                : head,
          },
        },
      }),
    },
    pulls: {
      get: async () => ({ data: { ...pr(), head: { ...pr().head, sha: option.headMoved ? 'f'.repeat(40) : head } } }),
      list: async () => ({ data: [] }),
      listFiles: async () => ({ data: [{ filename: 'change.ts' }] }),
      create: async (input: Record<string, unknown>) => {
        assert.equal(input.body, 'Closes #17\n\nPlain explanation\n\n<!-- ai-delivery:pr@1 -->');
        assert.equal(typeof input.title, 'string');
        assert.equal(typeof input.draft, 'boolean');
        publicationBody = input.body as string;
        publicationTitle = input.title as string;
        publicationDraft = input.draft as boolean;
        return { data: pr() };
      },
      getReview: async () => ({
        data: {
          id: 99,
          user: { login: 'reviewer[bot]' },
          state: 'APPROVED',
          commit_id: head,
          body: reviewBody,
          html_url: 'https://github.com/example/widget/pull/23#pullrequestreview-99',
        },
      }),
      listReviews: async () => ({
        data: [
          {
            id: 99,
            user: { login: 'reviewer[bot]' },
            state: 'APPROVED',
            commit_id: head,
            body: reviewBody,
          },
        ],
      }),
      merge: async (input: Record<string, unknown>) => {
        merges.push(input);
        merged = true;
        if (option.mergeAckLost) throw new Error('Merge acknowledgement lost');
        return { data: { merged: true, sha: merge } };
      },
    },
    issues: {
      get: async () => ({
        data: {
          number: 17,
          state: closes ? 'closed' : 'open',
          node_id: 'ISSUE',
          title: 'Improve widget',
          body: merged && option.retainedIssueDrift ? 'Changed criteria' : 'Retained criteria',
          html_url: 'https://github.com/example/widget/issues/17',
        },
      }),
      update: async (input: Record<string, unknown>) => {
        assert.equal(input.state, 'closed');
        if (option.failedClose && closes === 0) {
          closes++;
          throw new Error('Interrupted close');
        }
        closes++;
        return { data: { number: 17, state: 'closed' } };
      },
    },
  };
  const graphql = async (query: string) => {
    if (query.includes('DeliveryNonClosingReferences'))
      return {
        repository: {
          id: 'REPO',
          nameWithOwner: 'example/widget',
          issue: {
            id: 'ISSUE',
            number: 17,
            state: 'OPEN',
            timelineItems: {
              nodes: [
                {
                  id: 'REFERENCE',
                  actor: { login: 'author' },
                  isCrossRepository: false,
                  willCloseTarget: false,
                  source: {
                    __typename: 'PullRequest',
                    id: 'PR23',
                    number: 23,
                    repository: { id: 'REPO', nameWithOwner: 'example/widget' },
                  },
                  target: {
                    __typename: 'Issue',
                    id: 'ISSUE',
                    number: 17,
                    repository: { id: 'REPO', nameWithOwner: 'example/widget' },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('DeliveryNonClosingCommits'))
      return {
        repository: {
          nameWithOwner: 'example/widget',
          pullRequest: {
            id: 'PR23',
            number: 23,
            headRefOid: head,
            baseRefOid: base,
            baseRefName: 'main',
            commits: {
              totalCount: 1,
              nodes: [
                {
                  commit: {
                    oid: head,
                    message: option.commitMessage ?? 'Improve widget',
                    parents: {
                      totalCount: 1,
                      nodes: [{ oid: base }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('DeliveryClosingIssues'))
      return {
        repository: {
          nameWithOwner: 'example/widget',
          pullRequest: {
            id: 'PR23',
            number: 23,
            closingIssuesReferences: {
              nodes: option.nonClosing
                ? []
                : [{ number: option.wrongClosingIssue ? 18 : 17, repository: { nameWithOwner: 'example/widget' } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (option.deletedAfterMerge && merged && query.includes('DeliveryIssueBranches'))
      return {
        repository: { issue: { linkedBranches: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      };
    if (query.includes('DeliveryIssueBranches'))
      return {
        repository: {
          issue: {
            linkedBranches: {
              nodes: [
                {
                  ref: {
                    name: option.unrelatedBranch ? 'other/17' : 'issue/17',
                    target: { oid: head },
                    repository: { nameWithOwner: 'example/widget' },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('blockedBy'))
      return {
        repository: {
          issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, parent: null },
        },
      };
    if (option.decisionUnavailable) throw new Error('Fictional review decision unavailable');
    decisionRead = true;
    return {
      repository: {
        pullRequest: {
          headRefOid: option.decisionHeadMoved ? 'd'.repeat(40) : head,
          reviewDecision: Object.hasOwn(option, 'reviewDecision') ? option.reviewDecision : 'APPROVED',
        },
      },
    };
  };
  const reviewer = { role: 'reviewer', authSource: 'app', appActorLogin: async () => 'reviewer[bot]', rest, graphql };
  const context = {
    root: '/nonexistent-launch-directory',
    repo: { owner: 'example', repo: 'widget' },
    config: {
      schemaVersion: 'ai-delivery.github@1',
      repository: 'example/widget',
      roles: { author: { authSource: 'personal', identity: 'author' }, reviewer: { identity: 'reviewer' } },
    },
    clients: {
      role: 'author',
      authSource: 'personal',
      authenticatedAuthor: async () => ({ actorLogin: 'author', credentialIdentity: 'user:1' }),
      rest,
      graphql,
    },
    reviewerClients: reviewer,
  } as unknown as DeliveryContext;
  return { context, merges, closes: () => closes };
}

describe('remote GitHub lifecycle', () => {
  it('uses native eligibility without comparing historical artifact identity', async () => {
    const { context, merges } = fixture('clean', { reviewBinding: 'stale-head' });
    await mergePr(context, { issueNumber: 17, prNumber: 23, reviewedHeadSha: head });
    assert.equal(merges.length, 1);
    assert.equal(merges[0]?.sha, head);
  });
  it('accepts native PR association despite a superseded linked branch snapshot', async () => {
    const { context, merges } = fixture('clean', { unrelatedBranch: true });
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });

  for (const reviewBinding of [
    'stale-head',
    'wrong-tree',
    'wrong-scope',
    'invalid-digest',
    'marker-only',
    'wrong-issue',
    'wrong-pr',
    'wrong-role',
  ] as const) {
    it(`defers ${reviewBinding} historical review eligibility to GitHub`, async () => {
      const { context, merges } = fixture('clean', { reviewBinding });
      context.clients.rest.pulls.listReviews = (async () => {
        throw new Error('Historical review comparison must not run');
      }) as unknown as typeof context.clients.rest.pulls.listReviews;
      context.clients.rest.git.getCommit = (async () => {
        throw new Error('Historical tree comparison must not run');
      }) as unknown as typeof context.clients.rest.git.getCommit;
      context.clients.rest.pulls.listFiles = (async () => {
        throw new Error('Historical diff comparison must not run');
      }) as unknown as typeof context.clients.rest.pulls.listFiles;
      await mergePr(context, { issueNumber: 17, prNumber: 23 });
      assert.equal(merges.length, 1);
    });
  }
  it('merges a native zero-review decision without requiring an extra App approval', async () => {
    const { context, merges } = fixture('clean', { reviewDecision: null });
    delete context.reviewerClients;
    context.clients.rest.pulls.listReviews = (async () => {
      throw new Error('Extra approval must not be required');
    }) as unknown as typeof context.clients.rest.pulls.listReviews;
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
  for (const [status, conclusion] of [
    ['IN_PROGRESS', null],
    ['COMPLETED', 'FAILURE'],
    ['COMPLETED', 'TIMED_OUT'],
  ] as const) {
    it(`names the required native money-path-review blocker ${status}/${conclusion}`, async () => {
      const { context, merges } = fixture('blocked', {
        nativeChecks: [{ name: 'money-path-review', required: true, status, conclusion }],
      });
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /money-path-review/u);
      assert.equal(merges.length, 0);
    });
  }
  it('reports discovered required check names and permits a failed optional check', async () => {
    const { context, merges } = fixture('unstable', {
      nativeChecks: [
        { name: 'local-verify', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'money-path-review', required: true, status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { name: 'optional', required: false, status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    });
    const checks = await prChecks(context, 23);
    assert.deepEqual(
      (checks as unknown as { requiredChecks: Array<{ name: string }> }).requiredChecks.map((check) => check.name),
      ['local-verify', 'money-path-review'],
    );
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
  it('discovers required legacy names alongside a full page of head check runs', async () => {
    const { context, merges } = fixture('clean', {
      nativeChecks: Array.from({ length: 100 }, (_, i) => ({
        name: `optional${i}`,
        required: false,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      })),
      nativeStatuses: [{ name: 'legacy-required', required: true, state: 'SUCCESS' }],
    });
    const checks = await prChecks(context, 23);
    assert.deepEqual(
      checks.requiredChecks.map((check) => check.name),
      ['legacy-required'],
    );
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
  it('refuses GitHub blocked eligibility for a failing required legacy status', async () => {
    const { context, merges } = fixture('blocked', {
      nativeStatuses: [{ name: 'legacy-required', required: true, state: 'FAILURE' }],
    });
    await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /legacy-required/u);
    assert.equal(merges.length, 0);
  });
  it('refuses unavailable review decision readback even when GitHub REST is clean', async () => {
    const { context, merges } = fixture('clean', { decisionUnavailable: true });
    await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }));
    assert.equal(merges.length, 0);
  });
  for (const reviewDecision of [undefined, 'UNKNOWN', false, 0, {}, 'REVIEW_REQUIRED', 'CHANGES_REQUESTED']) {
    it(`refuses unavailable or blocking native review decision ${JSON.stringify(reviewDecision)}`, async () => {
      const { context, merges } = fixture('clean', { reviewDecision });
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }));
      assert.equal(merges.length, 0);
    });
  }
  for (const option of [
    { decisionHeadMoved: true },
    { baseChangedAfterDecision: 'name' },
    { baseChangedAfterDecision: 'sha' },
  ] as const) {
    it(`refuses native head/base decision drift ${JSON.stringify(option)}`, async () => {
      const { context, merges } = fixture('clean', option);
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }));
      assert.equal(merges.length, 0);
    });
  }
  it('accepts GitHub passing eligibility with native pre-receive hooks', async () => {
    const { context, merges } = fixture('has_hooks');
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
  it('names a configured required check that has never reported', async () => {
    const { context, merges } = fixture('blocked', {
      configuredRequiredChecks: ['local-verify', 'money-path-review'],
      nativeChecks: [{ name: 'local-verify', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const checks = await prChecks(context, 23);
    assert.deepEqual(
      checks.requiredChecks.map((check) => check.name),
      ['local-verify', 'money-path-review'],
    );
    await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /money-path-review/u);
    assert.equal(merges.length, 0);
  });
  it('retains configured requirements without relying on a check rollup', async () => {
    const { context } = fixture('blocked', { configuredRequiredChecks: ['money-path-review'] });
    const read = context.clients.graphql;
    context.clients.graphql = (async (query: string, variables: unknown) => {
      assert.ok(!query.includes('statusCheckRollup'));
      return read(query, variables as never);
    }) as typeof context.clients.graphql;
    const checks = await prChecks(context, 23);
    assert.deepEqual(checks.requiredChecks, [{ name: 'money-path-review', headState: 'not-reported' }]);
  });
  it('discovers an unreported classic-protection requirement', async () => {
    const { context } = fixture('blocked', {
      requirementsViaClassic: true,
      configuredRequiredChecks: ['classic-required'],
    });
    const checks = await prChecks(context, 23);
    assert.deepEqual(checks.requiredChecks, [{ name: 'classic-required', headState: 'not-reported' }]);
    assert.equal(checks.requiredCheckDiscovery, 'complete');
  });
  it('preserves a failing legacy status beside a successful same-name required check run', async () => {
    const { context, merges } = fixture('blocked', {
      nativeChecks: [{ name: 'money-path-review', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' }],
      nativeStatuses: [{ name: 'money-path-review', required: true, state: 'FAILURE' }],
    });
    const checks = await prChecks(context, 23);
    assert.equal(checks.headChecksComplete, true);
    assert.equal(checks.combinedStatus, 'failure');
    assert.equal(checks.requiredChecks.length, 1);
    assert.match(checks.requiredChecks[0]!.headState, /success/u);
    assert.match(checks.requiredChecks[0]!.headState, /failure/u);
    await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /money-path-review/u);
    assert.equal(merges.length, 0);
  });
  it('declares requirement discovery partial when native rule reads are unavailable', async () => {
    const { context } = fixture('blocked', { requirementsUnavailable: true });
    const checks = await prChecks(context, 23);
    assert.equal((checks as unknown as { requiredCheckDiscovery: string }).requiredCheckDiscovery, 'partial');
  });
  it('refuses publication of a collaborator PR before promotion', async () => {
    const { context } = fixture();
    context.clients.rest.pulls.list = (async () => ({
      data: [{ number: 23 }],
    })) as typeof context.clients.rest.pulls.list;
    const get = context.clients.rest.pulls.get;
    context.clients.rest.pulls.get = (async (...args: Parameters<typeof get>) => {
      const response = await get(...args);
      return { ...response, data: { ...response.data, user: { ...response.data.user, login: 'collaborator' } } };
    }) as typeof get;
    await assert.rejects(publishPr(context, { issueNumber: 17, dryRun: true }), /author/u);
  });

  it('refuses a non-default PR base before publication', async () => {
    const { context } = fixture();
    await assert.rejects(publishPr(context, { issueNumber: 17, baseBranch: 'release' }), /default branch/u);
  });
  it('refuses conflicting prior PR metadata during dry-run before promotion', async () => {
    const { context } = fixture();
    context.clients.rest.pulls.list = (async () => ({
      data: [{ number: 23 }],
    })) as typeof context.clients.rest.pulls.list;
    await assert.rejects(publishPr(context, { issueNumber: 17, body: 'Different intent', dryRun: true }), /conflict/u);
  });

  it('reads every PR match page before refusing ambiguous branch publication', async () => {
    const { context } = fixture();
    context.clients.rest.pulls.list = (async (input: { page?: number }) => ({
      data: input.page === 2 ? [{ number: 24 }] : Array.from({ length: 100 }, () => ({ number: 23 })),
    })) as unknown as typeof context.clients.rest.pulls.list;
    await assert.rejects(publishPr(context, { issueNumber: 17, dryRun: true }), /conflict/u);
  });
  it('creates a PR from its remote issue branch with a plain body and no local evidence', async () => {
    const { context } = fixture();
    const result = await publishPr(context, {
      issueNumber: 17,
      title: 'Improve widget',
      body: 'Plain explanation',
      draft: false,
    });
    assert.equal((result as { prNumber: number }).prNumber, 23);
  });

  for (const state of ['blocked', 'behind', 'dirty', 'unknown', null]) {
    it(`refuses GitHub merge eligibility ${String(state)} without a local receipt fallback`, async () => {
      const { context, merges } = fixture(state);
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /GitHub|mergeable|clean|CLEAN/u);
      assert.equal(merges.length, 0);
    });
  }

  it('uses the independent reviewed SHA as the server merge precondition', async () => {
    const { context, merges } = fixture();
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
    assert.equal(merges[0]?.sha, head);
  });

  it('finishes remotely and reuses the merged PR on an interrupted close retry', async () => {
    const { context, merges, closes } = fixture();
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
    assert.equal(closes(), 1);
  });
  for (const [name, option] of [
    ['moved base', { baseMoved: true }],
    ['moved reviewed head', { headMoved: true }],
    ['unknown decision', { reviewDecision: 'UNKNOWN' }],
    ['required review', { reviewDecision: 'REVIEW_REQUIRED' }],
  ] as const) {
    it(`refuses ${name} without merge or issue closure`, async () => {
      const { context, merges, closes } = fixture('clean', option);
      await assert.rejects(finishIssue(context, { issueNumber: 17, prNumber: 23 }));
      assert.equal(merges.length, 0);
      assert.equal(closes(), 0);
    });
  }

  it('finishes a merged PR after its issue branch was deleted', async () => {
    const { context, merges, closes } = fixture('clean', { deletedAfterMerge: true });
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
    assert.equal(closes(), 1);
  });
  it('never closes another issue after merged-PR association readback disagrees', async () => {
    const { context, closes, merges } = fixture('clean', { wrongClosingIssue: true });
    await assert.rejects(finishIssue(context, { issueNumber: 17, prNumber: 23 }));
    assert.equal(merges.length, 0);
    assert.equal(closes(), 0);
  });
});

describe('managed squash usage trailer', () => {
  const footer = '\n\n<!-- ai-delivery:pr@1 -->';
  const trailer = '\n\nDelivered-by: ai-delivery';
  const content = 'Closes #17\n\nOriginal body.  \r\n\n```md\n<!-- ai-delivery:pr@1 -->\n```';
  for (const marked of [false, true]) {
    for (const queued of [false, true]) {
      it(`sends one closing squash trailer with exact substantive bytes (${marked}, queue=${queued})`, async () => {
        const { context, merges } = fixture('clean', { prBody: content + (marked ? footer : '') });
        const input = { issueNumber: 17, prNumber: 23, reviewedHeadSha: head };
        const preview = await mergePr(context, { ...input, dryRun: true });
        assert.equal(Reflect.get(preview, 'commit_title'), 'Improve widget');
        assert.equal(Reflect.get(preview, 'commit_message'), content + trailer);
        assert.notEqual(Reflect.get(preview, 'nonClosing'), true);
        assert.equal(merges.length, 0);
        const stages: string[] = [];
        await mergePr(
          context,
          input,
          queued
            ? {
                expectedBase: 'c'.repeat(40),
                checkProof: async () => {
                  stages.push('proof');
                },
                beforeMutation: async () => {
                  stages.push('intent');
                },
              }
            : undefined,
        );
        assert.deepEqual(stages, queued ? ['proof', 'intent'] : []);
        assert.deepEqual(merges[0], {
          owner: 'example',
          repo: 'widget',
          pull_number: 23,
          sha: head,
          merge_method: 'squash',
          commit_title: 'Improve widget',
          commit_message: content + trailer,
        });
        assert.equal((await mergePr(context, input)).reused, true);
        assert.equal(merges.length, 1);
      });
    }
  }
  for (const strategy of ['merge', 'rebase'] as const) {
    it(`preserves native ${strategy} messages without a squash trailer`, async () => {
      const { context, merges } = fixture('clean', { prBody: content + footer, messageChangedAfterDecision: 'body' });
      await mergePr(context, { issueNumber: 17, prNumber: 23, strategy });
      assert.deepEqual(merges[0], {
        owner: 'example',
        repo: 'widget',
        pull_number: 23,
        sha: head,
        merge_method: strategy,
      });
    });
  }
  for (const field of ['title', 'body'] as const) {
    for (const mode of ['direct', 'queued', 'dry-run'] as const) {
      it(`refuses closing squash ${field} drift after the review read (${mode})`, async () => {
        const { context, merges } = fixture('clean', { messageChangedAfterDecision: field });
        const stages: string[] = [];
        await assert.rejects(
          mergePr(
            context,
            { issueNumber: 17, prNumber: 23, dryRun: mode === 'dry-run' },
            mode === 'queued'
              ? {
                  expectedBase: 'c'.repeat(40),
                  checkProof: async () => {
                    stages.push('proof');
                  },
                  beforeMutation: async () => {
                    stages.push('intent');
                  },
                }
              : undefined,
          ),
          /message.*changed|message.*drift/iu,
        );
        assert.equal(merges.length, 0);
        assert.deepEqual(stages, []);
      });
    }
  }
  it('does not duplicate a canonical final trailer already present in substantive content', async () => {
    const { context, merges } = fixture('clean', { prBody: content + trailer + footer });
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges[0]!.commit_message, content + trailer);
  });
});

describe('retained issue guarded squash delivery', () => {
  const input = { issueNumber: 17, prNumber: 23, reviewedHeadSha: head, nonClosing: true };
  it('sends explicit safe squash messages at the approved SHA and reuses merged readback without closing', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true });
    const preview = await mergePr(context, { ...input, dryRun: true });
    assert.ok('commit_title' in preview && 'commit_message' in preview);
    assert.equal(preview.commit_title, 'Improve widget');
    assert.equal(
      preview.commit_message,
      'References example/widget#17\n\nDelivered by PR #23.\n\nDelivered-by: ai-delivery',
    );
    assert.equal(merges.length, 0);
    const result = await mergePr(context, input);
    assert.equal(result.mergeSha, merge);
    assert.equal(merges[0]!.sha, head);
    assert.equal(merges[0]!.merge_method, 'squash');
    assert.equal(merges[0]!.commit_title, preview.commit_title);
    assert.equal(merges[0]!.commit_message, preview.commit_message);
    assert.equal((await mergePr(context, input)).reused, true);
    assert.equal(merges.length, 1);
    assert.equal(closes(), 0);
  });

  for (const strategy of ['merge', 'rebase'] as const) {
    it(`refuses ${strategy} before any lifecycle mutation`, async () => {
      const { context, merges, closes } = fixture('clean', { nonClosing: true });
      await assert.rejects(mergePr(context, { ...input, strategy }), /squash/u);
      assert.equal(merges.length, 0);
      assert.equal(closes(), 0);
    });
  }
  it('refuses finish before even reading or merging the PR', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true });
    context.clients.rest.pulls.get = (() => {
      throw new Error('No lifecycle call allowed');
    }) as unknown as typeof context.clients.rest.pulls.get;
    await assert.rejects(finishIssue(context, input), /cannot finish/u);
    assert.equal(merges.length, 0);
    assert.equal(closes(), 0);
  });
  for (const option of [
    { reviewDecision: 'REVIEW_REQUIRED' },
    { baseMoved: true },
    { headMoved: true },
    { commitMessage: 'Fixes: other/repo#5' },
  ]) {
    it(`preserves fail-closed merge guards: ${JSON.stringify(option)}`, async () => {
      const { context, merges, closes } = fixture('clean', { ...option, nonClosing: true });
      await assert.rejects(mergePr(context, input));
      assert.equal(merges.length, 0);
      assert.equal(closes(), 0);
    });
  }
  it('reports post-merge issue criteria drift without reopening or replaying the merge', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true, retainedIssueDrift: true });
    await assert.rejects(mergePr(context, input), /criteria drifted/u);
    assert.equal(merges.length, 1);
    assert.equal(closes(), 0);
  });
  it('reconciles an uncertain merge acknowledgement through authoritative merged readback', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true, mergeAckLost: true });
    await assert.rejects(mergePr(context, input), /acknowledgement lost/u);
    assert.equal((await mergePr(context, input)).reused, true);
    assert.equal(merges.length, 1);
    assert.equal(closes(), 0);
  });
});

// Recorded fragments are injected at the existing GitHub boundary. Ready/CLEAN,
// issue/PR aliases and call interleaving below are explicitly synthetic.
function recordedFlow(
  input: {
    headSha?: string;
    baseSha?: string;
    mainSha?: string;
    draft?: boolean;
    state?: string;
    missingDecision?: boolean;
    failedCheck?: boolean;
    missingCheck?: boolean;
  } = {},
) {
  const headSha = input.headSha ?? recordedZeroApproval.repository.pullRequest.headRefOid;
  const baseSha = input.baseSha ?? recordedZeroApproval.repository.pullRequest.baseRefOid;
  const current = fixture(input.state ?? 'clean', {
    headSha,
    baseSha,
    reviewDecision: null,
    configuredRequiredChecks: ['checks'],
    nativeChecks: input.missingCheck
      ? []
      : [
          {
            name: 'checks',
            required: true,
            status: 'COMPLETED',
            conclusion: input.failedCheck ? 'FAILURE' : 'SUCCESS',
          },
        ],
  });
  const { context } = current;
  const events: string[] = [];
  const { pulls, git, issues } = context.clients.rest;
  const get = pulls.get;
  pulls.get = (async (...args: Parameters<typeof get>) => {
    assert.deepEqual(args[0], { owner: 'example', repo: 'widget', pull_number: 23 });
    events.push('pr');
    const result = await get(...args);
    return { ...result, data: { ...result.data, draft: input.draft ?? false } };
  }) as typeof get;
  const graphql = context.clients.graphql;
  context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
    if (!query.includes('DeliveryReviewDecision')) return graphql(query, variables);
    assert.deepEqual(variables, { owner: 'example', name: 'widget', number: 23 });
    events.push('decision');
    return {
      repository: {
        pullRequest: {
          headRefOid: headSha,
          ...(input.missingDecision
            ? {}
            : { reviewDecision: recordedZeroApproval.repository.pullRequest.reviewDecision }),
        },
      },
    };
  }) as typeof graphql;
  const getRef = git.getRef;
  git.getRef = (async (...args: Parameters<typeof getRef>) => {
    const result = await getRef(...args);
    if (args[0]?.ref !== 'heads/main') return result;
    events.push('main');
    return { ...result, data: { ...result.data, object: { type: 'commit', sha: input.mainSha ?? baseSha } } };
  }) as typeof getRef;
  const merge = pulls.merge;
  pulls.merge = (async (...args: Parameters<typeof merge>) => {
    events.push('merge');
    assert.deepEqual(args[0], {
      owner: 'example',
      repo: 'widget',
      pull_number: 23,
      sha: headSha,
      merge_method: 'squash',
      commit_title: 'Improve widget',
      commit_message: 'Closes #17\n\nDelivered-by: ai-delivery',
    });
    return merge(...args);
  }) as typeof merge;
  const update = issues.update;
  issues.update = (async (...args: Parameters<typeof update>) => {
    events.push('close');
    assert.deepEqual(args[0], {
      owner: 'example',
      repo: 'widget',
      issue_number: 17,
      state: 'closed',
      state_reason: 'completed',
    });
    return update(...args);
  }) as typeof update;
  return { ...current, events };
}

describe('recorded public fragments with labeled synthetic transitions', () => {
  it('keeps the observed zero-review draft ineligible without merge or closure', async () => {
    const current = recordedFlow({ draft: recordedZeroApproval.repository.pullRequest.isDraft });
    await assert.rejects(finishIssue(current.context, { issueNumber: 17, prNumber: 23 }), /open and ready/u);
    assert.deepEqual(current.events, ['pr']);
    assert.equal(current.merges.length + current.closes(), 0);
  });

  it('finishes a synthetic ready/CLEAN transition with observed null and exact head', async () => {
    const current = recordedFlow();
    const result = await finishIssue(current.context, { issueNumber: 17, prNumber: 23 });
    assert.equal(result.headSha, '4b54bd4b663a32957e4571e2af112f828fbc0a58');
    assert.equal(current.closes(), 1);
    assert.equal(current.merges.length, 1);
    assert.deepEqual(current.events, ['pr', 'pr', 'decision', 'pr', 'main', 'merge', 'pr', 'pr', 'close']);
  });

  it('performs no mutation for the synthetic ready/null finish dry-run', async () => {
    const current = recordedFlow();
    const result = await finishIssue(current.context, { issueNumber: 17, prNumber: 23, dryRun: true });
    assert.ok('dryRun' in result && result.dryRun);
    assert.deepEqual(current.events, ['pr', 'pr', 'decision', 'pr', 'main']);
    assert.equal(current.merges.length + current.closes(), 0);
  });

  it('refuses a synthetic missing decision rather than treating it as observed null', async () => {
    const current = recordedFlow({ missingDecision: true });
    await assert.rejects(finishIssue(current.context, { issueNumber: 17, prNumber: 23 }), /review eligibility/u);
    assert.deepEqual(current.events, ['pr', 'pr', 'decision', 'pr']);
    assert.equal(current.merges.length + current.closes(), 0);
  });

  for (const [name, input] of [
    ['failed required check', { state: 'blocked', failedCheck: true }],
    ['missing required check', { state: 'blocked', missingCheck: true }],
    ['behind', { state: 'behind' }],
    ['dirty', { state: 'dirty' }],
  ] as const) {
    it(`refuses synthetic native ${name} without merge or closure`, async () => {
      const current = recordedFlow(input);
      await assert.rejects(
        finishIssue(current.context, { issueNumber: 17, prNumber: 23 }),
        /GitHub merge eligibility/u,
      );
      assert.deepEqual(current.events, ['pr', 'pr', 'decision', 'pr']);
      assert.equal(current.merges.length + current.closes(), 0);
    });
  }

  it('refuses recorded UNKNOWN drift and a synthetic CLEAN interleaving, then accepts a fresh retry', async () => {
    const before = recordedBaseDrift.before.repository.pullRequest;
    const drift = recordedBaseDrift.after.repository;
    const unknown = recordedFlow({
      headSha: before.headRefOid,
      baseSha: before.baseRefOid,
      state: drift.pullRequest.mergeStateStatus.toLowerCase(),
    });
    await assert.rejects(mergePr(unknown.context, { issueNumber: 17, prNumber: 23 }), /GitHub merge eligibility/u);
    assert.deepEqual(unknown.events, ['pr', 'pr', 'decision', 'pr']);
    const race = recordedFlow({
      headSha: before.headRefOid,
      baseSha: before.baseRefOid,
      mainSha: drift.defaultBranchRef.target.oid,
    });
    await assert.rejects(finishIssue(race.context, { issueNumber: 17, prNumber: 23 }), /base moved/u);
    assert.deepEqual(race.events, ['pr', 'pr', 'decision', 'pr', 'main']);
    assert.equal(unknown.merges.length + race.merges.length + race.closes(), 0);
    // New synthetic refreshed candidate; no automatic approval carry-forward.
    const retry = recordedFlow({ headSha: before.headRefOid, baseSha: drift.defaultBranchRef.target.oid });
    await mergePr(retry.context, {
      issueNumber: 17,
      prNumber: 23,
      reviewedHeadSha: '47cb7643c494c44bdecdfe8ca7449c7b3b884aaa',
    });
    assert.equal(retry.merges.length, 1);
    assert.deepEqual(retry.events, ['pr', 'pr', 'decision', 'pr', 'main', 'merge', 'pr']);
  });
});

describe('verified finish registered source cleanup', () => {
  for (const mode of [
    'clean',
    'squash',
    'dirty',
    'unretained',
    'mismatched',
    'ignored',
    'hidden',
    'unregistered',
    'absent',
    'wrong-pr',
    'symbolic',
    'aliased',
    'ineligible',
    'dry-run',
  ] as const) {
    it(`finishes with ${mode} local source without losing unretained data`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-cleanup-')));
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      try {
        git(root, 'init', '-q', '-b', 'main');
        git(root, 'config', 'user.name', 'Fixture');
        git(root, 'config', 'user.email', 'fixture@example.invalid');
        writeFileSync(join(root, 'change.ts'), 'base\n');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'base');
        const base = git(root, 'rev-parse', 'HEAD');
        git(root, 'remote', 'add', 'origin', 'https://github.com/example/widget.git');
        const path = join(root, '.worktrees', 'issue-17');
        git(root, 'worktree', 'add', '-b', 'issue/17', path);
        writeFileSync(join(path, 'change.ts'), 'delivered\n');
        git(path, 'commit', '-qam', 'change');
        const source = git(path, 'rev-parse', 'HEAD');
        let merged = source;
        if (mode === 'squash') {
          git(root, 'merge', '--squash', 'issue/17');
          git(root, 'commit', '-qm', 'squash');
          merged = git(root, 'rev-parse', 'HEAD');
        }
        git(root, 'update-ref', 'refs/remotes/origin/main', mode === 'unretained' ? base : merged);
        git(root, 'update-ref', 'refs/heads/unrelated', base);
        if (mode !== 'unregistered')
          await addWorktreeEntry(
            {
              path,
              branch: 'issue/17',
              type: 'issue',
              identity: 'author',
              issueNumber: 17,
              prNumber: mode === 'wrong-pr' ? 24 : 23,
              status: 'pr-published',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            root,
          );
        if (mode === 'dirty' || mode === 'hidden') writeFileSync(join(path, 'change.ts'), 'local data\n');
        if (mode === 'hidden') git(path, 'update-index', '--assume-unchanged', 'change.ts');
        if (mode === 'mismatched') git(path, 'checkout', '-b', 'other');
        if (mode === 'ignored') {
          writeFileSync(join(root, '.git', 'info', 'exclude'), 'cached.txt\n');
          writeFileSync(join(path, 'cached.txt'), 'local data\n');
        }
        if (mode === 'absent') {
          git(root, 'worktree', 'remove', path);
          git(root, 'update-ref', '-d', 'refs/heads/issue/17', source);
        }
        if (mode === 'symbolic') {
          git(root, 'worktree', 'remove', path);
          git(root, 'update-ref', 'refs/heads/unrelated', source);
          git(root, 'symbolic-ref', 'refs/heads/issue/17', 'refs/heads/unrelated');
        }
        if (mode === 'aliased') {
          renameSync(join(root, '.worktrees'), join(root, 'physical-source'));
          symlinkSync(join(root, 'physical-source'), join(root, '.worktrees'), 'dir');
        }
        const f = fixture(mode === 'ineligible' ? 'blocked' : 'clean', {
          headSha: source,
          headTree: git(root, 'rev-parse', `${source}^{tree}`),
          baseSha: base,
          mergeSha: mode === 'unretained' ? 'b'.repeat(40) : merged,
          remoteBaseSha: merged,
        });
        f.context.root = root;
        if (mode === 'ineligible' || mode === 'dry-run') {
          const finish = () => finishIssue(f.context, { issueNumber: 17, prNumber: 23, dryRun: mode === 'dry-run' });
          if (mode === 'ineligible') await assert.rejects(finish());
          else await finish();
          assert.equal(existsSync(path), true);
          assert.equal(git(root, 'rev-parse', 'refs/heads/issue/17'), source);
          assert.equal(readFileSync(join(path, 'change.ts'), 'utf8'), 'delivered\n');
          return;
        }
        const result = await finishIssue(f.context, { issueNumber: 17, prNumber: 23 });
        assert.ok('issueClosed' in result && result.issueClosed);
        assert.ok('cleanup' in result);
        if (mode === 'clean' || mode === 'squash' || mode === 'absent') {
          assert.deepEqual(result.cleanup, { status: 'removed' });
          assert.equal(existsSync(path), false);
          assert.throws(() => git(root, 'rev-parse', '--verify', 'refs/heads/issue/17'));
          assert.deepEqual(listWorktreesStrict(root), []);
          const replay = await finishIssue(f.context, { issueNumber: 17, prNumber: 23 });
          assert.ok('issueClosed' in replay && replay.issueClosed);
        } else if (mode === 'symbolic') {
          assert.equal(existsSync(path), false);
          assert.equal(git(root, 'symbolic-ref', 'refs/heads/issue/17'), 'refs/heads/unrelated');
          assert.equal(git(root, 'rev-parse', 'refs/heads/unrelated'), source);
          assert.equal(result.cleanup.status, 'retained');
        } else {
          assert.equal(existsSync(path), true);
          assert.equal(git(root, 'rev-parse', 'refs/heads/issue/17'), source);
          assert.equal(
            readFileSync(join(path, 'change.ts'), 'utf8'),
            mode === 'dirty' || mode === 'hidden' ? 'local data\n' : 'delivered\n',
          );
          if (mode === 'ignored') assert.equal(readFileSync(join(path, 'cached.txt'), 'utf8'), 'local data\n');
          assert.ok(JSON.stringify(result).includes(mode === 'unregistered' ? 'absent' : 'retained'));
        }
        assert.equal(git(root, 'rev-parse', 'refs/heads/unrelated'), mode === 'symbolic' ? source : base);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
