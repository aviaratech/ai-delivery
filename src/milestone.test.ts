import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeliveryContext } from './issue.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { createMilestone } from './milestone.js';

interface FakeMilestone {
  description: string | null;
  due_on: string | null;
  html_url: string;
  number: number;
  title: string;
}

/** A repository whose milestones live in a list; records every create call. */
function fakeRepository(initial: FakeMilestone[] = [], options: { dropDueDate?: boolean } = {}) {
  const milestones = [...initial];
  const created: Record<string, unknown>[] = [];
  const issues = {
    createMilestone: async (input: { description?: string; due_on?: string; title: string }) => {
      created.push(input);
      const milestone: FakeMilestone = {
        description: input.description ?? null,
        due_on: options.dropDueDate === true ? null : (input.due_on ?? null),
        html_url: `https://github.com/aviaratech/ai/milestone/${milestones.length + 1}`,
        number: milestones.length + 1,
        title: input.title,
      };
      milestones.push(milestone);
      return { data: milestone };
    },
    getMilestone: async (input: { milestone_number: number }) => ({
      data: milestones.find((milestone) => milestone.number === input.milestone_number)!,
    }),
    listMilestones: async () => ({ data: milestones }),
  };
  const rest = { issues };
  const context = {
    clients: { rest },
    repo: { owner: 'aviaratech', repo: 'ai' },
  } as unknown as DeliveryContext;
  return { context, created };
}

test('milestone_create makes a milestone with a due date and description and reads it back', async () => {
  const repository = fakeRepository();
  const result = await createMilestone(repository.context, {
    description: 'R12: speed lane',
    dueOn: '2026-11-27',
    title: 'R12',
  });
  assert.deepEqual(result, {
    created: true,
    description: 'R12: speed lane',
    dueOn: '2026-11-27',
    number: 1,
    title: 'R12',
    url: 'https://github.com/aviaratech/ai/milestone/1',
  });
  assert.equal(repository.created[0]!.due_on, '2026-11-27T00:00:00Z');
});

test('repeating the same milestone_create returns the milestone it made and creates no second one', async () => {
  const repository = fakeRepository();
  const input = { dueOn: '2026-11-27', title: 'R12' };
  await createMilestone(repository.context, input);
  const again = await createMilestone(repository.context, input);
  assert.equal(again.created, false);
  assert.equal(again.number, 1);
  assert.equal(repository.created.length, 1);
});

test('a same-titled milestone with a different due date is refused with its number', async () => {
  const repository = fakeRepository([
    { description: null, due_on: '2026-12-01T00:00:00Z', html_url: 'https://example.test/1', number: 7, title: 'R12' },
  ]);
  await assert.rejects(
    createMilestone(repository.context, { dueOn: '2026-11-27', title: 'R12' }),
    /Milestone #7 is already titled "R12" with a different description or due date/u,
  );
  assert.equal(repository.created.length, 0);
});

test('a readback that lost the due date fails instead of reporting success', async () => {
  const repository = fakeRepository([], { dropDueDate: true });
  await assert.rejects(
    createMilestone(repository.context, { dueOn: '2026-11-27', title: 'R12' }),
    /readback differs from the requested title, description or due date/u,
  );
});

test('the milestone_create tool takes a title, an ISO date and a description and refuses a bad date', () => {
  const tool = getAiDeliveryMcpTool('milestone_create')!;
  assert.equal(tool.commandName, 'milestone:create');
  assert.ok(tool.inputSchema.safeParse({ description: 'x', dueOn: '2026-11-27', title: 'R12' }).success);
  assert.equal(tool.inputSchema.safeParse({ dueOn: '11/27/2026', title: 'R12' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ title: '  ' }).success, false);
});
