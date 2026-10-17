import assert from 'node:assert/strict';
import { test } from 'vitest';
import { updateIssue, createIssue, CreatedTrackingIssueError } from './issue.js';
import { issue63Fixture as guardFixture } from './fixtures/issue63.js';

test('forward creation reads a known Blocked item when its list status projection is empty', async () => {
  const f = guardFixture();
  f.controls.missingProjectStatus = 20;
  const result = await createIssue(f.context, { ...f.ready, blockedBy: [18] });
  assert.equal(result.created.number, 20);
  assert.equal(result.created.url, 'https://github.com/example/widget/issues/20');
  assert.deepEqual([...f.edges.get(20)!], [18]);
  assert.equal(f.statuses.get(20), 'Waiting');
  assert.ok(f.writes.indexOf('status') < f.writes.indexOf('add'));
  assert.deepEqual(
    f.graphqlCalls.filter((call) => call.query.includes('addBlockedBy')).map((call) => call.variables),
    [{ blocking: 'ISSUE18', issue: 'ISSUE20' }],
  );
  const reads = f.graphqlCalls.filter((call) => call.query.includes('ProjectDeliveryItemReadback'));
  assert.ok(reads.length >= 2, 'Status synchronization and dependency guard must read the exact item.');
  assert.ok(reads.every((call) => call.variables.itemId === 'ITEM20' && call.variables.statusField === 'Flow'));
  assert.equal(f.comments.length, 0);
});

test('a forward dependency failure preserves the created issue and update repairs its Blocked item', async () => {
  const f = guardFixture();
  f.controls.missingProjectStatus = 20;
  f.controls.failAdd = true;
  await assert.rejects(createIssue(f.context, { ...f.ready, blockedBy: [18] }), (error) => {
    assert.ok(error instanceof CreatedTrackingIssueError);
    assert.deepEqual(error.created, {
      number: 20,
      title: f.ready.title,
      url: 'https://github.com/example/widget/issues/20',
    });
    assert.match(error.message, /Native add failed/u);
    assert.match(error.message, /Resume this known issue/u);
    return true;
  });
  assert.equal(f.statuses.get(20), 'Waiting');
  assert.deepEqual([...f.edges.get(20)!], []);
  f.controls.failAdd = false;
  const repaired = await updateIssue(f.context, { issueNumber: 20, blockedBy: [18] });
  assert.equal(repaired.issueNumber, 20);
  assert.equal(repaired.projectStatus, 'Blocked');
  assert.deepEqual(repaired.blockedBy, [18]);
  await updateIssue(f.context, { issueNumber: 20, blockedBy: [18] });
  assert.equal(f.writes.filter((write) => write === 'create').length, 1);
  assert.equal(f.writes.filter((write) => write === 'add').length, 1);
  assert.deepEqual([...f.edges.get(20)!], [18]);
});

test('an exact active item still requires an override when the list projection is empty', async () => {
  const f = guardFixture();
  f.controls.missingProjectStatus = 17;
  await assert.rejects(updateIssue(f.context, { issueNumber: 17, blockedBy: [18] }), /overrideReason/u);
  assert.deepEqual(f.writes, []);
  await updateIssue(f.context, {
    issueNumber: 17,
    blockedBy: [18],
    overrideReason: 'Wait for the newly identified prerequisite.',
  });
  assert.deepEqual([...f.edges.get(17)!], [18]);
  assert.equal(f.comments.length, 1);
});

test('missing or contradictory exact item evidence refuses a dependency without writes', async () => {
  for (const readback of [
    { fieldValueByName: null },
    { isArchived: true },
    { id: 'ITEM18' },
    { project: { id: 'OTHER', number: 1 } },
    { project: { id: 'PROJECT', number: 2 } },
    { content: { id: 'ISSUE18' } },
    { fieldValueByName: { name: 'Waiting', optionId: 'ACTIVE' } },
  ]) {
    const f = guardFixture();
    f.statuses.set(17, 'Waiting');
    f.controls.missingProjectStatus = 17;
    f.controls.projectItemReadback = readback;
    await assert.rejects(updateIssue(f.context, { issueNumber: 17, blockedBy: [18] }), /Project/u);
    assert.deepEqual(f.writes, []);
    assert.deepEqual([...f.edges.get(17)!], []);
  }
  const absent = guardFixture();
  absent.controls.missingProjectIssue = 17;
  await assert.rejects(updateIssue(absent.context, { issueNumber: 17, blockedBy: [18] }), /unresolved/u);
  assert.deepEqual(absent.writes, []);
});

test('new blocker on active work refuses before every affected write without an override reason', async () => {
  const f = guardFixture();
  await assert.rejects(updateIssue(f.context, { issueNumber: 17, blockedBy: [18] }), /overrideReason/u);
  assert.deepEqual(f.writes, []);
});

test('reciprocal creation preflights the active dependent before creating an issue', async () => {
  const f = guardFixture();
  await assert.rejects(
    createIssue(f.context, { ...f.ready, blocks: [17] } as Parameters<typeof createIssue>[1]),
    /overrideReason/u,
  );
  assert.deepEqual(f.writes, []);
});

test('an authorized active addition records verified evidence before the edge and retries once', async () => {
  const f = guardFixture();
  f.controls.failAdd = true;
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Await prerequisite validation.' }),
    /Native add failed/u,
  );
  assert.equal(f.comments.length, 1);
  assert.equal(f.edges.get(17)?.size, 0);
  const evidence = f.comments[0]!.body;
  f.controls.failAdd = false;
  await updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Await prerequisite validation.' });
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0]!.body, evidence);
  assert.deepEqual([...f.edges.get(17)!], [18]);
  assert.ok(f.writes.indexOf('comment') < f.writes.indexOf('add'));
});
test('verified evidence conflicts and comment readback drift refuse the native edge', async () => {
  const f = guardFixture();
  f.controls.failAdd = true;
  await assert.rejects(updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Original reason' }));
  f.controls.failAdd = false;
  const priorWrites = [...f.writes];
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Changed reason' }),
    /conflicts/u,
  );
  assert.deepEqual(f.writes, priorWrites);
  assert.equal(f.comments.length, 1);
  assert.equal(f.edges.get(17)?.size, 0);
  const other = guardFixture();
  other.controls.corruptComment = true;
  await assert.rejects(
    updateIssue(other.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Documented prerequisite' }),
    /readback/u,
  );
  assert.equal(other.edges.get(17)?.size, 0);
});
test('actual additions are guarded after an initially existing edge disappears', async () => {
  const f = guardFixture();
  f.edges.get(17)!.add(18);
  f.controls.race = () => f.edges.get(17)!.clear();
  await assert.rejects(updateIssue(f.context, { issueNumber: 17, blockedBy: [18] }), /overrideReason/u);
  assert.equal(f.edges.get(17)?.size, 0);
  assert.ok(!f.writes.includes('add'));
});
test('preflight active observation remains sticky after a concurrent status change', async () => {
  const f = guardFixture();
  f.controls.race = () => f.statuses.set(17, 'Queued');
  await updateIssue(f.context, {
    issueNumber: 17,
    blockedBy: [18],
    overrideReason: 'Required despite concurrent parking',
  });
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0]!.body, /In Progress/u);
});
test('inactive addition needs no override while a newly active dependent is guarded', async () => {
  const f = guardFixture();
  f.statuses.set(17, 'Queued');
  await updateIssue(f.context, { issueNumber: 17, blockedBy: [18] });
  assert.equal(f.comments.length, 0);
  const race = guardFixture();
  race.statuses.set(17, 'Queued');
  race.controls.race = () => race.statuses.set(17, 'Active');
  await assert.rejects(updateIssue(race.context, { issueNumber: 17, blockedBy: [18] }), /overrideReason/u);
  assert.ok(!race.writes.includes('add'));
});
test('remove and re-add uses a new native removal episode', async () => {
  const f = guardFixture();
  await updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'First episode' });
  f.edges.get(17)!.clear();
  f.statuses.set(17, 'Active');
  f.history.push({
    __typename: 'BlockedByRemovedEvent',
    id: 'REMOVE1',
    createdAt: '2026-01-02T00:00:00Z',
    blockingIssue: { id: 'ISSUE18', number: 18, repository: { nameWithOwner: 'example/widget' } },
  });
  await updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Second episode' });
  assert.equal(f.comments.length, 2);
  assert.match(f.comments[1]!.body, /REMOVE1/u);
});
test('incomplete active history and unavailable author refuse before writes', async () => {
  const f = guardFixture();
  f.controls.timelineIncomplete = true;
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Reason' }),
    /Complete dependency history/u,
  );
  assert.deepEqual(f.writes, []);
  const noAuthor = guardFixture();
  noAuthor.controls.actor = '';
  await assert.rejects(
    updateIssue(noAuthor.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Reason' }),
    /Author unavailable/u,
  );
  assert.deepEqual(noAuthor.writes, []);
});
test('reciprocal create preserves unrelated edges and provides known-created recovery', async () => {
  const f = guardFixture();
  f.edges.get(17)!.add(19);
  f.controls.failAdd = true;
  await assert.rejects(
    createIssue(f.context, { ...f.ready, blocks: [17], overrideReason: 'New prerequisite' }),
    (error) => error instanceof CreatedTrackingIssueError && error.created.number === 20,
  );
  assert.deepEqual([...f.edges.get(17)!], [19]);
  assert.equal(f.comments.length, 1);
  f.controls.failAdd = false;
  await updateIssue(f.context, { issueNumber: 20, blocks: [17], overrideReason: 'New prerequisite' });
  assert.deepEqual([...f.edges.get(17)!], [19, 20]);
  assert.equal(f.comments.length, 1);
});

test('forward create refuses PR and foreign endpoint identities before creation', async () => {
  for (const bad of [{ pull_request: {} }, { html_url: 'https://github.com/foreign/repo/issues/18' }, { number: 19 }]) {
    const f = guardFixture();
    Object.assign(f.rows.get(18)!, bad);
    await assert.rejects(createIssue(f.context, { ...f.ready, blockedBy: [18] }), /endpoint|repository issue/u);
    assert.deepEqual(f.writes, []);
  }
});
test('missing blocker identity and ambiguous removal history refuse during preflight', async () => {
  const f = guardFixture();
  f.history.push({
    __typename: 'BlockedByRemovedEvent',
    id: 'R',
    createdAt: '2026-01-01T00:00:00Z',
    blockingIssue: null,
  });
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Reason' }),
    /Complete dependency history/u,
  );
  assert.deepEqual(f.writes, []);
  const ambiguous = guardFixture();
  for (const id of ['R1', 'R2'])
    ambiguous.history.push({
      __typename: 'BlockedByRemovedEvent',
      id,
      createdAt: '2026-01-01T00:00:00Z',
      blockingIssue: { id: 'ISSUE18', number: 18, repository: { nameWithOwner: 'example/widget' } },
    });
  await assert.rejects(
    updateIssue(ambiguous.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Reason' }),
    /ambiguous/u,
  );
  assert.deepEqual(ambiguous.writes, []);
});
test('a removal during comment readback refuses authority from the earlier episode', async () => {
  const f = guardFixture();
  f.controls.commentRace = () =>
    f.history.push({
      __typename: 'BlockedByRemovedEvent',
      id: 'LATER',
      createdAt: '2026-01-03T00:00:00Z',
      blockingIssue: { id: 'ISSUE18', number: 18, repository: { nameWithOwner: 'example/widget' } },
    });
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Reason' }),
    /episode changed/u,
  );
  assert.equal(f.edges.get(17)?.size, 0);
  assert.ok(!f.writes.includes('add'));
});

test('duplicate authority markers are refused before another content write', async () => {
  const f = guardFixture();
  f.controls.failAdd = true;
  await assert.rejects(updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Reason' }));
  f.comments.push({ ...f.comments[0]!, id: 999 });
  f.controls.failAdd = false;
  const before = [...f.writes];
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, blockedBy: [18], overrideReason: 'Reason' }),
    /duplicate/u,
  );
  assert.deepEqual(f.writes, before);
});
