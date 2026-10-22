import assert from 'node:assert/strict';
import { test } from 'vitest';
import { issueInfo, listIssueSubissues } from './issue.js';
import { issue63Fixture } from './fixtures/issue63.js';
import { CollectionLimitError } from './errors.js';

function rollupFixture() {
  const f = issue63Fixture();
  const children = [18, 19, 20].map((number) => ({
    ...f.rows.get(18)!,
    id: 100 + number,
    node_id: `ISSUE${number}`,
    number,
    state: number === 18 ? 'closed' : 'open',
    html_url: `https://github.com/example/widget/issues/${number}`,
    url: `https://api.github.com/repos/example/widget/issues/${number}`,
    repository_url: 'https://api.github.com/repos/example/widget',
  }));
  for (const child of children) f.rows.set(child.number, child);
  f.statuses.set(18, 'Active');
  f.statuses.set(19, 'Queued');
  f.statuses.set(20, 'Active');
  const points = new Map<number, unknown>([
    [17, '2'],
    [18, '4'],
    [19, '1'],
    [20, '2'],
  ]);
  const dates = new Map<number, unknown>([
    [18, '1900-01-01'],
    [19, '2020-02-29'],
    [20, null],
  ]);
  const controls = {
    pages: [children] as unknown[][],
    links: new Map<number, string>(),
    failedPage: 0,
    dateMode: 'configured',
    projectIdentity: 'PROJECT',
    projectCursor: null as unknown,
    missingProjectIssue: undefined as number | undefined,
    archivedChildren: new Set<number>(),
    failChildProjectRead: false,
  };
  const childPages: number[] = [];
  const metadataReads: number[] = [];
  const refuseWrite = async () => {
    throw new Error('Unexpected rollup native issue mutation');
  };
  f.context.clients.rest.issues.create = refuseWrite as unknown as typeof f.context.clients.rest.issues.create;
  f.context.clients.rest.issues.update = refuseWrite as unknown as typeof f.context.clients.rest.issues.update;
  f.context.clients.rest.issues.createComment =
    refuseWrite as unknown as typeof f.context.clients.rest.issues.createComment;
  f.context.clients.rest.issues.listSubIssues = (async (input: Record<string, unknown>) => {
    assert.equal(input.owner, 'example');
    assert.equal(input.repo, 'widget');
    assert.equal(input.issue_number, 17, 'Rollup must not recurse into a child');
    const page = Number(input.page ?? 1);
    childPages.push(page);
    if (page === controls.failedPage)
      throw Object.assign(new Error('Synthetic child page unavailable'), { status: 409 });
    return { data: controls.pages[page - 1] ?? [], headers: { link: controls.links.get(page) } };
  }) as unknown as typeof f.context.clients.rest.issues.listSubIssues;
  f.context.clients.rest.request = (async (route: string, input: Record<string, unknown>) => {
    if (route === 'GET /orgs/{org}/issue-fields')
      return {
        data: [
          { id: 101, name: 'Estimate', data_type: 'single_select' },
          { id: 102, name: 'Urgency', data_type: 'single_select' },
          ...(controls.dateMode === 'missing'
            ? []
            : [{ id: 104, name: 'Target date', data_type: controls.dateMode === 'wrong' ? 'text' : 'date' }]),
        ],
      };
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') {
      assert.equal(input.owner, 'example');
      assert.equal(input.repo, 'widget');
      const number = Number(input.issue_number);
      metadataReads.push(number);
      return {
        data: [
          ...(points.has(number)
            ? [
                {
                  issue_field_id: 101,
                  issue_field_name: 'Estimate',
                  data_type: 'single_select',
                  value: points.get(number),
                },
              ]
            : []),
          ...(controls.dateMode === 'missing' || !dates.has(number)
            ? []
            : [
                {
                  issue_field_id: 104,
                  issue_field_name: 'Target date',
                  data_type: controls.dateMode === 'wrong' ? 'text' : 'date',
                  value: dates.get(number),
                },
              ]),
        ],
      };
    }
    throw new Error(`Unexpected rollup REST operation ${route}`);
  }) as typeof f.context.clients.rest.request;
  const graphql = f.context.clients.graphql;
  f.context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
    assert.ok(!/\bmutation\b/u.test(query), 'Rollup must never write Project or issue state');
    if (
      controls.failChildProjectRead &&
      query.includes('ProjectDeliveryItems') &&
      metadataReads.some((number) => number !== 17)
    )
      throw new Error('Synthetic child Project read unavailable');
    f.controls.missingProjectIssue = controls.missingProjectIssue;
    const result = await graphql(query, variables);
    if (query.includes('blockedBy(first:'))
      Object.assign((result as { repository: { issue: Record<string, unknown> } }).repository.issue, {
        id: `ISSUE${String(variables.number)}`,
        number: variables.number,
        repository: { nameWithOwner: 'example/widget' },
      });
    if (query.includes('ProjectDeliveryItems')) {
      const project = (result as { organization: { projectV2: Record<string, unknown> } }).organization.projectV2;
      project.id = controls.projectIdentity;
      project.number = 1;
      const items = project.items as {
        nodes: { content: { id: string }; isArchived: boolean }[];
        pageInfo: { endCursor: unknown };
      };
      items.pageInfo.endCursor = controls.projectCursor;
      for (const item of items.nodes)
        if (controls.archivedChildren.has(Number(item.content.id.replace('ISSUE', '')))) item.isArchived = true;
    }
    return result;
  }) as typeof f.context.clients.graphql;
  const read = async () => (await issueInfo(f.context, 17)) as unknown as Record<string, unknown>;
  return { ...f, nativeControls: f.controls, children, points, dates, controls, childPages, metadataReads, read };
}

test('parent readback counts direct children and preserves live status and overdue open dates', async () => {
  const f = rollupFixture();
  assert.deepEqual((await f.read()).childProgress, {
    childCount: 3,
    closedChildCount: 1,
    percentClosed: 33.3,
    pointsTotal: 7,
    inProgressChildren: [18, 20],
    nextTargetDate: '2020-02-29',
    missingPoints: [],
    missingProjectStatus: [],
    undatedOpenChildren: [20],
    targetDateConfigured: true,
  });
  assert.deepEqual(f.childPages, [1]);
  assert.deepEqual(f.writes, []);
});

test('a successful zero-child read preserves leaf shape', async () => {
  const f = rollupFixture();
  f.controls.pages = [[]];
  const info = await f.read();
  assert.equal(Object.hasOwn(info, 'childProgress'), false);
  assert.equal(info.title, f.rows.get(17)!.title);
  assert.deepEqual(f.writes, []);
});

test('short child pages with next links contribute to one complete direct rollup', async () => {
  const f = rollupFixture();
  f.controls.pages = [[f.children[1]], [f.children[0], f.children[2]]];
  f.controls.links.set(
    1,
    '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=2>; rel="next"',
  );
  const progress = (await f.read()).childProgress as { pointsTotal: number; childCount: number };
  assert.ok(progress, 'Parent progress is missing from readback');
  assert.equal(progress.childCount, 3);
  assert.equal(progress.pointsTotal, 7);
  assert.deepEqual(f.childPages, [1, 2]);
});

test('a bounded caller refuses child pagination before requesting a page outside its scope', async () => {
  const f = rollupFixture();
  f.context.readPageLimit = 1;
  f.controls.pages = [[f.children[0]], [f.children[1], f.children[2]]];
  f.controls.links.set(
    1,
    '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=2>; rel="next"',
  );
  await assert.rejects(
    () => listIssueSubissues(f.context, 17),
    (error: unknown) => {
      assert.ok(error instanceof CollectionLimitError);
      assert.equal(error.collection, 'native-sub-issues');
      assert.equal(error.pagesRequested, 1);
      assert.equal(error.rowsObserved, 1);
      assert.equal(error.limit, 1);
      return true;
    },
  );
  assert.deepEqual(f.childPages, [1]);
  assert.deepEqual(f.metadataReads, []);
  assert.deepEqual(f.writes, []);
});

test('bounded parent progress preserves the Project definition page budget', async () => {
  const f = rollupFixture();
  f.context.readPageLimit = 1;
  const graphql = f.context.clients.graphql;
  let definitionRequests = 0;
  f.context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
    if (query.includes('ProjectDeliveryConfiguration')) {
      definitionRequests++;
      return {
        organization: {
          projectV2: {
            id: 'PROJECT',
            number: 1,
            title: 'Delivery',
            closed: false,
            viewerCanUpdate: true,
            fields: {
              nodes: [],
              pageInfo: { hasNextPage: definitionRequests === 1, endCursor: `page-${String(definitionRequests)}` },
            },
          },
        },
      };
    }
    const result = await graphql(query, variables);
    // The parent already captured its configuration; force fresh discovery for the child rollup.
    if (query.includes('ProjectDeliveryItems')) delete f.context.projectConfiguration;
    return result;
  }) as typeof f.context.clients.graphql;
  await assert.rejects(f.read, (error: unknown) => {
    assert.ok(error instanceof CollectionLimitError);
    assert.equal(error.collection, 'project-fields');
    assert.equal(error.pagesRequested, 1);
    assert.equal(error.rowsObserved, 0);
    assert.equal(error.limit, 1);
    return true;
  });
  assert.equal(definitionRequests, 1);
  assert.deepEqual(f.metadataReads, [17]);
  assert.deepEqual(f.writes, []);
});

test('bounded parent progress preserves each child Project status page budget', async () => {
  const f = rollupFixture();
  f.context.readPageLimit = 1;
  const graphql = f.context.clients.graphql;
  let childProjectRequests = 0;
  f.context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
    const result = await graphql(query, variables);
    if (query.includes('ProjectDeliveryItems') && f.metadataReads.some((number) => number !== 17)) {
      childProjectRequests++;
      const project = (result as { organization: { projectV2: { items: { nodes: unknown[]; pageInfo: unknown } } } })
        .organization.projectV2;
      if (variables.cursor !== null) project.items.nodes = [];
      project.items.pageInfo = { hasNextPage: variables.cursor === null, endCursor: 'child-page-1' };
    }
    return result;
  }) as typeof f.context.clients.graphql;
  await assert.rejects(f.read, (error: unknown) => {
    assert.ok(error instanceof CollectionLimitError);
    assert.equal(error.collection, 'project-items');
    assert.equal(error.pagesRequested, 1);
    assert.equal(error.rowsObserved, f.rows.size);
    assert.equal(error.limit, 1);
    return true;
  });
  assert.equal(childProjectRequests, 1);
  assert.deepEqual(f.metadataReads, [17, 18]);
  assert.deepEqual(f.writes, []);
});

for (const page of [1, 2])
  test(`HTTP409 on child page ${page} refuses complete progress and numeric child listing`, async () => {
    const f = rollupFixture();
    f.controls.failedPage = page;
    f.controls.links.set(
      1,
      '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=2>; rel="next"',
    );
    await assert.rejects(f.read, /child page unavailable/u);
    await assert.rejects(() => listIssueSubissues(f.context, 17), /child page unavailable/u);
    assert.deepEqual(f.writes, []);
  });

test('explicitly unset Points and established missing status remain unavailable', async () => {
  const f = rollupFixture();
  f.points.set(19, null);
  f.controls.dateMode = 'missing';
  f.controls.missingProjectIssue = 20;
  const progress = (await f.read()).childProgress as Record<string, unknown>;
  assert.ok(progress, 'Parent progress is missing from readback');
  assert.equal(progress.pointsTotal, null);
  assert.deepEqual(progress.missingPoints, [19]);
  assert.equal(progress.inProgressChildren, null);
  assert.deepEqual(progress.missingProjectStatus, [20]);
  assert.equal(progress.targetDateConfigured, false);
  assert.equal(progress.nextTargetDate, null);
  assert.deepEqual(progress.undatedOpenChildren, [19, 20]);
});

for (const mutation of ['foreign', 'duplicate'])
  test(`${mutation} child identity refuses before child metadata reads`, async () => {
    const f = rollupFixture();
    if (mutation === 'foreign') f.children[0]!.repository_url = 'https://api.github.com/repos/foreign/widget';
    else f.controls.pages[0]!.push({ ...f.children[0] });
    await assert.rejects(f.read, /child|repository|duplicate/iu);
    assert.equal(
      f.metadataReads.some((number) => number !== 17),
      false,
    );
    assert.deepEqual(f.writes, []);
  });

test('individually valid Points cannot produce an unsafe aggregate', async () => {
  const f = rollupFixture();
  f.context.config.native.points = { ...f.context.config.native.points, values: ['1', '2', '4', '9007199254740991'] };
  f.points.set(18, '9007199254740991');
  await assert.rejects(f.read, /aggregate|safe integer|overflow/iu);
});

for (const cursor of [undefined, 9])
  test(`strict child status rejects malformed final Project cursor ${String(cursor)}`, async () => {
    const f = rollupFixture();
    f.controls.projectCursor = cursor;
    await assert.rejects(f.read, /pagination|cursor/iu);
  });

test('child status refuses a different Project identity', async () => {
  const f = rollupFixture();
  f.controls.projectIdentity = 'WRONG-PROJECT';
  await assert.rejects(f.read, /Project identity/iu);
});

for (const identity of ['database', 'node'])
  test(`a child cannot reuse the parent's ${identity} identity under another number`, async () => {
    const f = rollupFixture();
    if (identity === 'database') f.children[0]!.id = f.rows.get(17)!.id;
    else f.children[0]!.node_id = f.rows.get(17)!.node_id;
    await assert.rejects(f.read, /child|self|identity/iu);
    assert.equal(
      f.metadataReads.some((number) => number !== 17),
      false,
    );
  });

for (const link of [
  '<https://api.github.com/repos/foreign/widget/issues/17/sub_issues?per_page=100&page=2>; rel="next"',
  '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=1>; rel="next"',
  'invalid pagination',
  '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=3>; rel="last"',
  '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=2>; rel="next", <https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=1>; rel="last"',
  '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=1>; rel="last", <https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=1>; rel="last"',
  '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=2>; rel="prev"',
  '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=2>; rel="next", <https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=9007199254740992>; rel="last"',
])
  test(`child pagination refuses ${link}`, async () => {
    const f = rollupFixture();
    f.controls.links.set(1, link);
    await assert.rejects(f.read, /pagination/iu);
    assert.equal(
      f.metadataReads.some((number) => number !== 17),
      false,
    );
  });

test('duplicate identities on a later child page refuse the whole aggregate', async () => {
  const f = rollupFixture();
  f.controls.pages = [[f.children[0]], [f.children[1], { ...f.children[0] }]];
  f.controls.links.set(
    1,
    '<https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=2>; rel="next"',
  );
  await assert.rejects(f.read, /duplicate/iu);
  assert.equal(
    f.metadataReads.some((number) => number !== 17),
    false,
  );
});

for (const value of [undefined, 'not-a-number', ' 2'])
  test(`a present malformed Points payload ${String(value)} cannot become missing Points`, async () => {
    const f = rollupFixture();
    f.points.set(19, value);
    await assert.rejects(f.read, /value|payload/iu);
  });

for (const value of ['2026-02-29', '2028-02-30', '2028-02-29T00:00:00Z'])
  test(`an invalid child calendar date ${value} refuses a next-date summary`, async () => {
    const f = rollupFixture();
    f.dates.set(19, value);
    await assert.rejects(f.read, /date/iu);
  });

test('a named Target date definition with the wrong type is not unconfigured', async () => {
  const f = rollupFixture();
  f.controls.dateMode = 'wrong';
  await assert.rejects(f.read, /Target date|incompatible/iu);
});

test('strict catalog reads follow a short next-linked page', async () => {
  const f = rollupFixture();
  const request = f.context.clients.rest.request;
  const pages: number[] = [];
  f.context.clients.rest.request = (async (route: string, input: Record<string, unknown>) => {
    const result = await request(route, input);
    if (route !== 'GET /orgs/{org}/issue-fields') return result;
    const page = Number(input.page);
    pages.push(page);
    const data = result.data as unknown[];
    return page === 1
      ? {
          data: data.slice(0, 1),
          headers: { link: '<https://api.github.com/orgs/example/issue-fields?per_page=100&page=2>; rel="next"' },
        }
      : { data: data.slice(1), headers: {} };
  }) as typeof f.context.clients.rest.request;
  const progress = (await f.read()).childProgress as Record<string, unknown>;
  assert.equal(progress.targetDateConfigured, true);
  assert.equal(progress.nextTargetDate, '2020-02-29');
  assert.deepEqual(pages, [1, 2]);
});

test('an unavailable later metadata page does not produce a partial Points total', async () => {
  const f = rollupFixture();
  const request = f.context.clients.rest.request;
  f.context.clients.rest.request = (async (route: string, input: Record<string, unknown>) => {
    if (route.includes('issue-field-values') && input.issue_number === 19) {
      if (input.page === 2) throw Object.assign(new Error('Synthetic metadata page unavailable'), { status: 409 });
      const first = await request(route, input);
      return {
        data: (first.data as unknown[]).slice(0, 1),
        headers: {
          link: '<https://api.github.com/repos/example/widget/issues/19/issue-field-values?per_page=100&page=2>; rel="next"',
        },
      };
    }
    return request(route, input);
  }) as typeof f.context.clients.rest.request;
  await assert.rejects(f.read, /metadata page unavailable/iu);
});

test('a full native child page continues before publishing the aggregate', async () => {
  const f = rollupFixture();
  const full = Array.from({ length: 100 }, (_, index) => ({
    ...f.children[1]!,
    number: 1000 + index,
    id: 2000 + index,
    node_id: `ISSUE${1000 + index}`,
    html_url: `https://github.com/example/widget/issues/${1000 + index}`,
    url: `https://api.github.com/repos/example/widget/issues/${1000 + index}`,
  }));
  f.controls.pages = [full, [f.children[0]]];
  const progress = (await f.read()).childProgress as Record<string, unknown>;
  assert.equal(progress.childCount, 101);
  assert.equal(progress.closedChildCount, 1);
  assert.equal(progress.percentClosed, 1);
  assert.deepEqual(f.childPages, [1, 2]);
  assert.deepEqual(f.writes, []);
});

test('an empty probe after a full final page accepts consistent previous and last links', async () => {
  const f = rollupFixture();
  const full = Array.from({ length: 100 }, (_, index) => ({
    ...f.children[1]!,
    number: 1000 + index,
    id: 2000 + index,
    node_id: `ISSUE${1000 + index}`,
    html_url: `https://github.com/example/widget/issues/${1000 + index}`,
    url: `https://api.github.com/repos/example/widget/issues/${1000 + index}`,
  }));
  f.controls.pages = [full, []];
  const last = 'https://api.github.com/repos/example/widget/issues/17/sub_issues?per_page=100&page=1';
  f.controls.links.set(2, `<${last}>; rel="prev", <${last}>; rel="last"`);
  assert.equal((await listIssueSubissues(f.context, 17)).length, 100);
  assert.deepEqual(f.childPages, [1, 2]);
});

test('an archived child Project item is unavailable rather than In Progress', async () => {
  const f = rollupFixture();
  f.controls.archivedChildren.add(20);
  const progress = (await f.read()).childProgress as Record<string, unknown>;
  assert.equal(progress.inProgressChildren, null);
  assert.deepEqual(progress.missingProjectStatus, [20]);
  assert.equal(progress.pointsTotal, 7);
});

test('an exact-item fallback can establish a genuinely unset child status', async () => {
  const f = rollupFixture();
  f.nativeControls.missingProjectStatus = 20;
  f.nativeControls.projectItemReadback = { fieldValueByName: null };
  const progress = (await f.read()).childProgress as Record<string, unknown>;
  assert.equal(progress.inProgressChildren, null);
  assert.deepEqual(progress.missingProjectStatus, [20]);
  assert.ok(
    f.graphqlCalls.some(
      (call) => call.query.includes('ProjectDeliveryItemReadback') && call.variables.itemId === 'ITEM20',
    ),
  );
});

test('a failed child Project read refuses progress rather than claiming missing status', async () => {
  const f = rollupFixture();
  f.controls.failChildProjectRead = true;
  await assert.rejects(f.read, /child Project read unavailable/u);
  assert.deepEqual(f.writes, []);
});

for (const surface of ['catalog', 'values'])
  test(`contradictory ${surface} pagination cannot publish a complete rollup`, async () => {
    const f = rollupFixture();
    const request = f.context.clients.rest.request;
    f.context.clients.rest.request = (async (route: string, input: Record<string, unknown>) => {
      const result = await request(route, input);
      if (
        (surface === 'catalog' && route === 'GET /orgs/{org}/issue-fields') ||
        (surface === 'values' && route.includes('issue-field-values') && input.issue_number === 19)
      ) {
        const path =
          surface === 'catalog' ? '/orgs/example/issue-fields' : '/repos/example/widget/issues/19/issue-field-values';
        return { ...result, headers: { link: `<https://api.github.com${path}?per_page=100&page=3>; rel="last"` } };
      }
      return result;
    }) as typeof f.context.clients.rest.request;
    await assert.rejects(f.read, /pagination/iu);
  });
