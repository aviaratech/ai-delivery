import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { publishPr, prChecks, queueChecks } from './pr.js';
import type { DeliveryContext } from './issue.js';
import { digestValue } from './delivery/common.js';
import { recordedZeroApproval } from './fixtures/recordedGitHubFlows.js';
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
});
