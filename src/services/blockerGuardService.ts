import { z } from 'zod';
import type { DeliveryContext } from '../issue.js';
import { DeliveryError } from '../errors.js';
import { digestValue } from '../delivery/common.js';
import {
  getIssueProjectStatus,
  getProjectDeliveryConfiguration,
  projectSettingsFromDeliveryConfig,
} from '../github/projectDelivery.js';
import { getNativeBlockerRelationships } from '../github/relationships.js';
import { readIssueHistory } from '../github/issueHistory.js';

export const OverrideReason = z.string().trim().min(1).max(2000);
export interface BlockerIntent {
  dependent: number;
  blockers: number[];
  pendingBlocker?: boolean;
}
type Edge = { issueNumber: number; issueNodeId: string; blocker: number; blockerNodeId: string };

async function endpoint(context: DeliveryContext, number: number): Promise<string> {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new DeliveryError('Dependency endpoint must be a positive issue number.');
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: number })).data;
  const url = new URL(issue.html_url);
  if (
    issue.number !== number ||
    'pull_request' in issue ||
    !issue.node_id ||
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.pathname.toLowerCase() !== `/${context.repo.owner}/${context.repo.repo}/issues/${number}`.toLowerCase()
  )
    throw new DeliveryError('Dependency endpoint is not the requested repository issue.');
  return issue.node_id;
}

/** Read-only preflight plus a reconciled callback for every actual native addition. */
export async function prepareBlockerGuard(
  context: DeliveryContext,
  intents: BlockerIntent[],
  overrideReason?: string,
  forwardBlockers: number[] = [],
) {
  if (context.clients.role !== 'author' || !context.clients.authenticatedAuthor)
    throw new DeliveryError('Dependency writes require configured author authority.');
  const authority = await context.clients.authenticatedAuthor();
  if (!authority.actorLogin.trim()) throw new DeliveryError('Dependency author identity is unavailable.');
  const reason = overrideReason === undefined ? undefined : OverrideReason.parse(overrideReason);
  for (const blocker of forwardBlockers) await endpoint(context, blocker);
  const configuration =
    context.projectConfiguration ??
    (await getProjectDeliveryConfiguration({
      graphql: context.clients.graphql,
      org: context.config.native.organization,
      settings: projectSettingsFromDeliveryConfig(context.config),
    }));
  const required = new Map<number, string>();
  const currentStatus = async (number: number, id: string) => {
    const status = await getIssueProjectStatus({
      graphql: context.clients.graphql,
      issueNodeId: id,
      org: context.config.native.organization,
      configuration,
      maxPages: 20,
    });
    if (status === null)
      throw new DeliveryError(
        `Project status for dependent #${number} is unresolved; dependency additions were refused.`,
      );
    return status.status;
  };
  const requireReason = (number: number) => {
    if (reason === undefined)
      throw new DeliveryError(`Adding a blocker to active issue #${number} requires overrideReason.`);
  };
  const episodeFor = async (edge: Edge) => {
    const history = await readIssueHistory(context, edge.issueNumber, 20, edge.issueNodeId);
    if (!history.complete)
      throw new DeliveryError(
        `Complete dependency history is required for an active blocker override: ${history.reason ?? 'Incomplete timeline'}.`,
      );
    const removals = history.events
      .filter(
        (value) =>
          value.__typename === 'BlockedByRemovedEvent' &&
          value.blockingIssue?.id === edge.blockerNodeId &&
          value.blockingIssue.repository.nameWithOwner.toLowerCase() === context.config.repository.toLowerCase(),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (removals[0] && removals[1] && Date.parse(removals[1].createdAt) === Date.parse(removals[0].createdAt))
      throw new DeliveryError('Dependency removal episode is ambiguous.');
    return removals[0]?.id ?? 'complete-history:no-removal';
  };
  const verifyComment = async (id: number, body: string, number: number) => {
    const value = (await context.clients.rest.issues.getComment({ ...context.repo, comment_id: id })).data;
    if (
      value.id !== id ||
      value.body !== body ||
      value.user?.login.toLowerCase() !== authority.actorLogin.toLowerCase() ||
      value.issue_url !== `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/issues/${number}`
    )
      throw new DeliveryError(
        'Override comment author, body or issue readback disagrees; native dependency was not added.',
      );
  };
  const commentFor = async (edge: Edge, episode: string, observedAt: string) => {
    const identity = {
      schema: 'ai-delivery.blocker-override@1',
      repository: context.config.repository,
      projectId: configuration.projectId,
      dependent: { number: edge.issueNumber, id: edge.issueNodeId },
      blocker: { number: edge.blocker, id: edge.blockerNodeId },
      episode,
      reason,
      observedStatus: 'In Progress',
    };
    const marker = `<!-- ai-delivery:blocker-override@1:${digestValue({ repository: context.config.repository.toLowerCase(), projectId: configuration.projectId, dependentId: edge.issueNodeId, blockerId: edge.blockerNodeId, episode })} -->`;
    const matches: { id: number; body?: string | null }[] = [];
    let complete = false;
    for (let page = 1; page <= 20; page++) {
      const comments = (
        await context.clients.rest.issues.listComments({
          ...context.repo,
          issue_number: edge.issueNumber,
          per_page: 100,
          page,
        })
      ).data;
      matches.push(
        ...comments.filter(
          (value) =>
            value.body?.includes(marker) && value.user?.login.toLowerCase() === authority.actorLogin.toLowerCase(),
        ),
      );
      if (comments.length < 100) {
        complete = true;
        break;
      }
    }
    if (!complete || matches.length > 1)
      throw new DeliveryError('Override comment search is incomplete or has duplicate authoritative markers.');
    const render = (evidence: typeof identity & { observedAt: string }) =>
      `Blocker override requested for ${context.config.repository}#${edge.issueNumber} blocked by #${edge.blocker}.\n\n${marker}\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\``;
    let body = render({ ...identity, observedAt });
    if (matches[0]) {
      body = matches[0].body ?? '';
      const raw = body.match(/```json\n([\s\S]+)\n```$/u)?.[1];
      let saved: Record<string, unknown>;
      try {
        saved = JSON.parse(raw ?? '') as Record<string, unknown>;
      } catch {
        throw new DeliveryError('Override comment evidence is malformed.');
      }
      const { observedAt: prior, ...fields } = saved;
      if (
        typeof prior !== 'string' ||
        !z.iso.datetime().safeParse(prior).success ||
        JSON.stringify(fields) !== JSON.stringify(identity) ||
        body !== render(saved as typeof identity & { observedAt: string })
      )
        throw new DeliveryError('Existing override comment conflicts with the requested reason or endpoint evidence.');
      await verifyComment(matches[0].id, body, edge.issueNumber);
    }
    return { id: matches[0]?.id, body };
  };
  for (const intent of intents) {
    const id = await endpoint(context, intent.dependent);
    const existing = await getNativeBlockerRelationships({
      graphql: context.clients.graphql,
      repo: context.repo,
      issueNumber: intent.dependent,
    });
    const candidates: Edge[] = [];
    for (const blocker of new Set(intent.blockers)) {
      if (blocker === intent.dependent) throw new DeliveryError('An issue cannot block itself.');
      const blockerNodeId = await endpoint(context, blocker);
      if (!existing.blockers.some((value) => value.number === blocker))
        candidates.push({ issueNumber: intent.dependent, issueNodeId: id, blocker, blockerNodeId });
    }
    if (!intent.pendingBlocker && !candidates.length) continue;
    if ((await currentStatus(intent.dependent, id)) === 'In Progress') {
      const observedAt = new Date().toISOString();
      required.set(intent.dependent, observedAt);
      requireReason(intent.dependent);
      // Pending creation has no blocker node yet, but its dependent history must already be complete.
      if (intent.pendingBlocker) {
        const history = await readIssueHistory(context, intent.dependent, 20, id);
        if (!history.complete)
          throw new DeliveryError('Complete dependency history is required for an active blocker override.');
      }
      for (const edge of candidates) {
        const episode = await episodeFor(edge);
        await commentFor(edge, episode, observedAt);
      }
    }
  }
  return async (edge: Edge): Promise<void | boolean> => {
    const dependentId = await endpoint(context, edge.issueNumber),
      blockerId = await endpoint(context, edge.blocker);
    if (dependentId !== edge.issueNodeId || blockerId !== edge.blockerNodeId || dependentId === blockerId)
      throw new DeliveryError('Dependency endpoint identity changed.');
    if ((await currentStatus(edge.issueNumber, dependentId)) === 'In Progress' && !required.has(edge.issueNumber))
      required.set(edge.issueNumber, new Date().toISOString());
    if (!required.has(edge.issueNumber)) return;
    requireReason(edge.issueNumber);
    const actor = await context.clients.authenticatedAuthor!();
    if (
      actor.actorLogin.toLowerCase() !== authority.actorLogin.toLowerCase() ||
      actor.credentialIdentity !== authority.credentialIdentity
    )
      throw new DeliveryError('Dependency override author authority changed.');
    const episode = await episodeFor(edge);
    const comment = await commentFor(edge, episode, required.get(edge.issueNumber)!);
    const id =
      comment.id ??
      (
        await context.clients.rest.issues.createComment({
          ...context.repo,
          issue_number: edge.issueNumber,
          body: comment.body,
        })
      ).data.id;
    await verifyComment(id, comment.body, edge.issueNumber);
    // Enumeration and comment writes are not atomic with dependencies. Reconcile the exact episode again.
    if ((await episodeFor(edge)) !== episode)
      throw new DeliveryError(
        'Dependency removal episode changed after override verification; inspect native state and resume this issue.',
      );
    const final = await getNativeBlockerRelationships({
      graphql: context.clients.graphql,
      repo: context.repo,
      issueNumber: edge.issueNumber,
    });
    if (final.blockers.some((value) => value.id === edge.blockerNodeId)) return false;
  };
}
