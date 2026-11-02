import { DeliveryError } from './errors.js';
import type { DeliveryContext } from './issue.js';

export interface CreateMilestoneInput {
  title: string;
  description?: string;
  /** ISO date (YYYY-MM-DD). */
  dueOn?: string;
}
export interface MilestoneReadback {
  /** False when a milestone with this exact title and the same description and due date already existed. */
  created: boolean;
  description: string;
  dueOn: string | null;
  number: number;
  /** A repeat of the call can match a closed milestone, so say which. */
  state: 'closed' | 'open';
  title: string;
  url: string;
}

/** Create a repository milestone, or return the identical one a retry already created; read it back either way. */
export async function createMilestone(
  context: DeliveryContext,
  input: CreateMilestoneInput,
): Promise<MilestoneReadback> {
  const { rest } = context.clients;
  const description = input.description ?? '';
  const dueOn = input.dueOn ?? null;
  const same = (milestone: { description?: string | null; due_on?: string | null }) =>
    (milestone.description ?? '') === description && (milestone.due_on?.slice(0, 10) ?? null) === dueOn;
  const listed = (await rest.issues.listMilestones({ ...context.repo, per_page: 100, state: 'all' })).data;
  if (listed.length >= 100)
    throw new DeliveryError(
      'This repository has 100 or more milestones, so a duplicate title cannot be ruled out. Create it on GitHub.',
    );
  const existing = listed.find((milestone) => milestone.title === input.title);
  if (existing !== undefined && !same(existing))
    throw new DeliveryError(
      `Milestone #${existing.number} is already titled "${input.title}" with a different description or due date. Pick another title or edit that milestone on GitHub.`,
    );
  const milestone =
    existing ??
    (
      await rest.issues.createMilestone({
        ...context.repo,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(dueOn === null ? {} : { due_on: `${dueOn}T12:00:00Z` }),
      })
    ).data;
  const readback = (await rest.issues.getMilestone({ ...context.repo, milestone_number: milestone.number })).data;
  if (readback.title !== input.title || !same(readback))
    throw new DeliveryError(
      `Milestone #${milestone.number} now exists with due date ${readback.due_on?.slice(0, 10) ?? 'none'} and does not match the request. Fix it on GitHub.`,
    );
  return {
    created: existing === undefined,
    description: readback.description ?? '',
    dueOn: readback.due_on?.slice(0, 10) ?? null,
    number: readback.number,
    state: readback.state === 'closed' ? 'closed' : 'open',
    title: readback.title,
    url: readback.html_url,
  };
}
