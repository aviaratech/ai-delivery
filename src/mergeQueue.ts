import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertPrivateFile, digestValue } from './delivery/common.js';
import { DeliveryError } from './errors.js';
import { gitCommonDir, gitRoot } from './git.js';
import type { DeliveryContext } from './issue.js';
import { mergePr, queueChecks, queuePr } from './pr.js';
import * as githubClients from './github/client.js';
import { GIT_EXECUTABLE, GIT_INERT_ARGUMENTS, gitEnvironment } from './gitProcess.js';
import { readRepositoryCommandOutput } from './delivery/stage.js';
import {
  retainedWorktreeTransitionProducerDigest,
  withRuntimeSetupWriter,
  withWorktreeTransitionWriterAbsent,
} from './verification.js';
import { ensurePrivateDirectoryDurably, writePrivateJsonFileAtomically } from './utils/atomicJson.js';
import { withLock } from './utils/lockfile.js';

const Sha = z.string().regex(/^[a-f0-9]{40}$/u);
const Prediction = z.strictObject({ base: Sha, parent: Sha, sha: Sha, tree: Sha, inputs: z.string() });
const Notice = z.strictObject({ key: z.string().min(1), body: z.string().min(1) });
const Grant = z.strictObject({
  id: z.string().min(1),
  bodyDigest: z.string(),
  authorId: z.string().min(1),
  authorLogin: z.string().min(1),
  repositoryId: z.string().min(1),
  anchorId: z.string().min(1),
  anchorNumber: z.number().int().positive(),
  expiresAt: z.string(),
  consumed: z.number().int().nonnegative(),
  members: z
    .array(z.strictObject({ entryId: z.uuid(), prId: z.string().min(1), prNumber: z.number().int().positive() }))
    .min(1)
    .max(100),
});
type QueueGrant = z.infer<typeof Grant>;
const Entry = z.strictObject({
  id: z.string().uuid(),
  issueNumber: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  prId: z.string().min(1),
  head: Sha,
  authorLogin: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  notified: z.array(z.string()),
  notice: Notice.optional(),
  grantId: z.string().optional(),
  state: z.enum(['needs-approval', 'waiting', 'verifying', 'ready', 'merged', 'removed']),
  reason: z.string().optional(),
  prediction: Prediction.optional(),
  published: Sha.optional(),
  merge: z.strictObject({ sha: Sha, tree: Sha }).optional(),
});
type QueueEntry = z.infer<typeof Entry>;
const Pending = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ref'), entryId: z.uuid(), before: Sha.nullable(), after: Sha.nullable() }),
  z.strictObject({
    kind: z.literal('merge'),
    entryId: z.uuid(),
    head: Sha,
    base: Sha,
    tree: Sha,
    grantId: z.string(),
    grantDigest: z.string(),
  }),
  z.strictObject({
    kind: z.literal('comment'),
    entryId: z.uuid(),
    key: z.string(),
    body: z.string(),
    actor: z.string(),
    prId: z.string(),
  }),
]);
const Record = z.strictObject({
  schemaVersion: z.literal('ai-delivery.merge-queue@2'),
  binding: z.string(),
  baseRef: z.string().min(1),
  writerRoot: z.string().refine(isAbsolute),
  entries: z.array(Entry),
  grants: z.array(Grant),
  pending: Pending.optional(),
  halted: z.string().optional(),
  store: z
    .strictObject({ id: z.uuid(), dev: z.number().nullable(), ino: z.number().nullable(), removing: z.boolean() })
    .optional(),
  stateId: z.string(),
});
type Queue = z.infer<typeof Record>;
const active = (e: QueueEntry) => e.state !== 'merged' && e.state !== 'removed';
const drained = (q: Queue) =>
  !q.pending && !q.store && !q.halted && q.entries.every((e) => !active(e) && !e.published && !e.notice);

function configuredApprovers(context: DeliveryContext) {
  const map = context.config.schemaVersion === 'ai-delivery.github@1' ? context.config.mergeQueueApprovers : undefined;
  return (
    Object.entries(map ?? {}).find(([repo]) => repo.toLowerCase() === context.config.repository.toLowerCase())?.[1] ??
    []
  );
}
function approvalWait(context: DeliveryContext, reason?: string) {
  const logins = configuredApprovers(context);
  const required = logins.length
    ? `Needs approval from configured approvers: ${logins.map((login) => `@${login}`).join(', ')}.`
    : `Needs approval; configure mergeQueueApprovers for ${context.config.repository}.`;
  return reason && reason !== required ? `${reason} ${required}` : required;
}
function notice(entry: QueueEntry, key: string, text: string) {
  if (entry.notified.includes(key)) return;
  if (entry.notice) throw new DeliveryError('Queue notice must be reconciled before the next transition.');
  entry.notice = { key, body: `<!-- ai-delivery:merge-queue:${entry.id}:${key} -->\n@${entry.authorLogin} ${text}` };
}
function transition(entry: QueueEntry, state: QueueEntry['state'], reason?: string) {
  const changed = entry.state !== state;
  if (changed && entry.notice) throw new DeliveryError('Queue transition has an undelivered predecessor notice.');
  entry.state = state;
  if (reason === undefined) delete entry.reason;
  else entry.reason = reason;
  if (changed) entry.sequence++;
  if (state === 'needs-approval') {
    if (entry.notice?.key !== 'needs-approval') notice(entry, 'needs-approval', reason!);
  } else if (changed && state !== 'waiting') {
    const text =
      state === 'merged' ? `merged as ${entry.merge!.sha}` : state === 'removed' ? `removed: ${reason}` : state;
    notice(entry, `transition-${entry.sequence}`, `PR #${entry.prNumber} ${text}.`);
  }
}

const approvalFields = `__typename id body author{__typename login ... on User{id}} repository{id nameWithOwner}
  pullRequest{id number} createdAt updatedAt lastEditedAt editor{login} isMinimized`;
const NativeCommentEdit = z.object({
  __typename: z.literal('IssueComment'),
  id: z.string().min(1),
  lastEditedAt: z.iso.datetime({ offset: true }).nullable(),
  editor: z.object({ login: z.string().min(1) }).nullable(),
  isMinimized: z.boolean(),
});
const NativeApproval = NativeCommentEdit.extend({
  body: z.string(),
  author: z.object({ __typename: z.literal('User'), id: z.string().min(1), login: z.string().min(1) }),
  repository: z.object({ id: z.string().min(1), nameWithOwner: z.string() }),
  pullRequest: z.object({ id: z.string().min(1), number: z.number().int().positive() }),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
function approvalFailure(error: unknown) {
  return error instanceof DeliveryError
    ? error.message
    : 'Native GitHub approval read failed; authority is unavailable.';
}
function approvalDocument(body: string) {
  const lines = body.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
  if (
    lines.length !== 6 ||
    lines[0] !== 'ai-delivery merge approval v1' ||
    !lines[1]!.startsWith('repository: ') ||
    !lines[2]!.startsWith('pull-requests: ') ||
    lines[3] !== 'conditions: current-native-eligibility,current-queue-checks,predecessors-merged' ||
    lines[4] !== 'heads: current-native-eligible' ||
    !lines[5]!.startsWith('expires: ')
  )
    throw new DeliveryError('Unsupported approval format, heads policy or conditions.');
  const raw = lines[2]!.slice(15).split(','),
    prs = raw.map(Number),
    expiresAt = lines[5]!.slice(9);
  if (
    raw.length > 100 ||
    raw.some((pr) => !/^[1-9]\d*$/u.test(pr)) ||
    prs.some((pr) => !Number.isSafeInteger(pr)) ||
    new Set(prs).size !== prs.length
  )
    throw new DeliveryError('Approval requires 1–100 unique positive safe PR numbers.');
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString().replace('.000Z', 'Z') !== expiresAt
  )
    throw new DeliveryError('Approval expiry must be a valid explicit UTC instant with seconds.');
  return { repository: lines[1]!.slice(12), prs, expiresAt };
}
async function approvalComments(context: DeliveryContext, first: QueueEntry, repositoryId: string) {
  const comments: { id: string; body: string }[] = [],
    ids = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | null = null,
    total: number | undefined;
  for (let page = 0; page < 100; page++) {
    const result: {
      repository: {
        id: string;
        nameWithOwner: string;
        pullRequest: {
          id: string;
          number: number;
          comments: {
            totalCount: number;
            nodes: { id: string; body: string }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      } | null;
    } = await context.clients.graphql(
      `query DeliveryQueueApprovalComments($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){id nameWithOwner pullRequest(number:$number){id number comments(first:100,after:$cursor){totalCount nodes{${approvalFields}} pageInfo{hasNextPage endCursor}}}}}`,
      { ...context.repo, number: first.prNumber, cursor },
    );
    const pr = result.repository?.pullRequest,
      connection = pr?.comments;
    if (
      result.repository?.id !== repositoryId ||
      result.repository.nameWithOwner.toLowerCase() !== context.config.repository.toLowerCase() ||
      pr?.id !== first.prId ||
      pr.number !== first.prNumber ||
      !connection ||
      !Number.isSafeInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      (total !== undefined && total !== connection.totalCount) ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean'
    )
      throw new DeliveryError('Approval comment pagination or native target identity is incomplete.');
    total = connection.totalCount;
    for (const node of connection.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id || typeof node.body !== 'string' || ids.has(node.id))
        throw new DeliveryError('Approval comment identity is missing or duplicated.');
      ids.add(node.id);
      comments.push(node);
    }
    if (!connection.pageInfo.hasNextPage) {
      if (comments.length !== total) throw new DeliveryError('Approval comment history is incomplete.');
      return comments;
    }
    const next = connection.pageInfo.endCursor;
    if (!next || cursors.has(next)) throw new DeliveryError('Approval comment pagination did not advance.');
    cursors.add(next);
    cursor = next;
  }
  throw new DeliveryError('Approval comment history exceeds its bounded readback window.');
}
async function chooseApproval(
  context: DeliveryContext,
  q: Queue,
  first: QueueEntry,
  repositoryId: string,
): Promise<{ grant?: QueueGrant; reason: string; diagnostics: { id: string; reason: string }[] }> {
  const diagnostics: { id: string; reason: string }[] = [],
    candidates: QueueGrant[] = [];
  const logins = configuredApprovers(context).map((login) => login.toLowerCase());
  if (!logins.length) return { reason: approvalWait(context), diagnostics };
  try {
    const discovered = await approvalComments(context, first, repositoryId);
    const ids = new Set(discovered.filter((c) => c.body.startsWith('ai-delivery merge approval')).map((c) => c.id));
    for (const g of q.grants) if (g.members.some((m) => m.entryId === first.id)) ids.add(g.id);
    for (const id of ids) {
      try {
        const result = await context.clients.graphql<{ node: unknown }>(
          `query DeliveryQueueApprovalNode($id:ID!){node(id:$id){... on IssueComment{${approvalFields}}}}`,
          { id },
        );
        if (result.node === null) throw new DeliveryError('Approval comment is deleted or no longer readable.');
        const parsed = NativeApproval.safeParse(result.node);
        if (!parsed.success) throw new DeliveryError('Approval is missing native identity/edit proof.');
        const c = parsed.data,
          prior = q.grants.find((g) => g.id === id);
        if (c.lastEditedAt !== null || c.editor !== null) throw new DeliveryError('Approval was edited after posting.');
        if (c.isMinimized) throw new DeliveryError('Approval is minimized.');
        if (
          c.id !== id ||
          c.repository.id !== repositoryId ||
          c.repository.nameWithOwner.toLowerCase() !== context.config.repository.toLowerCase()
        )
          throw new DeliveryError('Approval native repository/comment identity changed.');
        if (!logins.includes(c.author.login.toLowerCase()))
          throw new DeliveryError('Approval author is not a configured approver.');
        const document = approvalDocument(c.body),
          expires = Date.parse(document.expiresAt);
        if (document.repository.toLowerCase() !== context.config.repository.toLowerCase())
          throw new DeliveryError('Approval names a different repository.');
        if (Date.parse(c.updatedAt) !== Date.parse(c.createdAt))
          throw new DeliveryError('Approval was edited after posting.');
        if (expires <= Date.parse(c.createdAt) || expires <= Date.now())
          throw new DeliveryError('Approval has expired or does not expire after its creation.');
        const entries = q.entries.filter(active);
        if (prior) {
          if (
            prior.bodyDigest !== digestValue(c.body) ||
            prior.authorId !== c.author.id ||
            prior.authorLogin.toLowerCase() !== c.author.login.toLowerCase() ||
            prior.anchorId !== c.pullRequest.id ||
            prior.anchorNumber !== c.pullRequest.number ||
            prior.consumed >= prior.members.length
          )
            throw new DeliveryError('Approval binding changed or was already consumed.');
          for (const [i, member] of prior.members.entries()) {
            const entry = q.entries.find((e) => e.id === member.entryId);
            if (
              !entry ||
              entry.prId !== member.prId ||
              entry.prNumber !== member.prNumber ||
              entry.grantId !== prior.id ||
              (i < prior.consumed
                ? entry.state !== 'merged' || !entry.merge
                : entries[i - prior.consumed]?.id !== entry.id)
            )
              throw new DeliveryError('Approval predecessor was removed, replaced or not merged through this grant.');
          }
          candidates.push(prior);
        } else {
          if (
            c.pullRequest.id !== first.prId ||
            c.pullRequest.number !== first.prNumber ||
            document.prs.some((number, i) => entries[i]?.prNumber !== number)
          )
            throw new DeliveryError('Approval must match the complete ordered FIFO prefix.');
          candidates.push({
            id,
            bodyDigest: digestValue(c.body),
            authorId: c.author.id,
            authorLogin: c.author.login,
            repositoryId,
            anchorId: c.pullRequest.id,
            anchorNumber: c.pullRequest.number,
            expiresAt: document.expiresAt,
            consumed: 0,
            members: entries
              .slice(0, document.prs.length)
              .map((e) => ({ entryId: e.id, prId: e.prId, prNumber: e.prNumber })),
          });
        }
      } catch (error) {
        diagnostics.push({ id, reason: approvalFailure(error) });
      }
    }
  } catch (error) {
    return {
      reason: `Approval evidence unavailable: ${approvalFailure(error)}`,
      diagnostics,
    };
  }
  return candidates.length === 1
    ? { grant: candidates[0]!, reason: '', diagnostics }
    : {
        reason: candidates.length
          ? 'Multiple eligible standing approvals are ambiguous; remove the unwanted grant.'
          : approvalWait(context),
        diagnostics,
      };
}
export interface QueueOptions {
  root: string;
  signal?: AbortSignal;
  onProgress?: (input: { completed: number; remaining: number; elapsedMs: number; reason: string }) => Promise<void>;
}

async function location(context: DeliveryContext, options: QueueOptions) {
  options.signal?.throwIfAborted();
  const repository = (await context.clients.rest.repos.get({ ...context.repo })).data;
  if (
    repository.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    !repository.node_id ||
    !repository.default_branch
  )
    throw new DeliveryError('Queue repository/default branch readback is incomplete.');
  const common = gitCommonDir(options.root);
  const directory = join(common, 'ai-delivery', 'merge-queue');
  for (const path of [join(common, 'ai-delivery'), directory]) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new DeliveryError('Queue directory ownership is unsafe.');
  }
  return {
    common,
    writerRoot: gitRoot(options.root),
    directory,
    path: join(directory, 'queue.json'),
    repositoryId: repository.node_id,
    baseRef: repository.default_branch,
    binding: digestValue({
      repository: repository.node_id,
      common,
      host: hostname(),
      uid: process.getuid?.(),
      config: context.configuration?.configDigest ?? context.config,
      runtime: retainedWorktreeTransitionProducerDigest(dirname(fileURLToPath(import.meta.url))),
    }),
  };
}
type Location = Awaited<ReturnType<typeof location>>;
function read(at: Location): Queue {
  if (!existsSync(at.path))
    return {
      schemaVersion: 'ai-delivery.merge-queue@2',
      binding: at.binding,
      baseRef: at.baseRef,
      writerRoot: at.writerRoot,
      entries: [],
      grants: [],
      stateId: '',
    };
  const q = Record.parse(JSON.parse(assertPrivateFile(at.path).toString('utf8')));
  const { stateId, ...content } = q;
  if (stateId !== digestValue(content) || q.binding !== at.binding || q.baseRef !== at.baseRef)
    throw new DeliveryError(
      'Queue state is corrupt or incompatible with this host, repository, base, configuration or runtime.',
    );
  return q;
}
function save(at: Location, q: Queue) {
  const { stateId: _prior, ...content } = q;
  writePrivateJsonFileAtomically(at.path, { ...content, stateId: digestValue(content) });
}
export async function queueStatus(context: DeliveryContext, options: QueueOptions) {
  const at = await location(context, options);
  const q = read(at);
  return {
    schemaVersion: q.schemaVersion,
    baseRef: q.baseRef,
    leaseRoot: q.writerRoot,
    entries: q.entries,
    pending: q.pending,
    halted: q.halted,
  };
}
export async function enqueuePr(
  context: DeliveryContext,
  input: { prNumber: number; issueNumber?: number },
  options: QueueOptions,
) {
  const at = await location(context, options);
  const { pr, issueNumber } = await queuePr(context, input.prNumber, input.issueNumber);
  if (pr.state !== 'open' || pr.merged || pr.draft || pr.base.ref !== at.baseRef || !pr.node_id)
    throw new DeliveryError('Queue add requires an open ready PR targeting the current default branch.');
  ensurePrivateDirectoryDurably(at.directory);
  return withLock(at.path, {
    operation: async () => {
      options.signal?.throwIfAborted();
      const q = read(at);
      const existing = q.entries.find((e) => e.prNumber === pr.number && e.state !== 'removed' && e.state !== 'merged');
      if (existing && (existing.issueNumber !== issueNumber || existing.prId !== pr.node_id))
        throw new DeliveryError('Queued PR identity conflicts.');
      const entry: QueueEntry = existing ?? {
        id: randomUUID(),
        prNumber: pr.number,
        issueNumber,
        prId: pr.node_id,
        head: pr.head.sha,
        authorLogin: pr.user.login,
        sequence: 0,
        notified: [],
        state: 'needs-approval',
      };
      if (!existing) {
        const admit = async () => {
          q.entries.push(entry);
          save(at, q);
        };
        if (drained(q) && q.writerRoot !== at.writerRoot) {
          const priorRoot = q.writerRoot;
          await withWorktreeTransitionWriterAbsent(at.writerRoot, priorRoot, async () => {
            q.writerRoot = at.writerRoot;
            await admit();
          });
        } else await admit();
      }
      return {
        entryId: entry.id,
        position:
          q.entries.filter((e) => e.state !== 'removed' && e.state !== 'merged').findIndex((e) => e.id === entry.id) +
          1,
        state: entry.state,
      };
    },
  });
}

const ref = (entry: QueueEntry) => `heads/ai-delivery/queue/${entry.prNumber}`;

/** Explicit foreground owner. The existing runtime writer owns and recovers child processes;
 * short queue-file locks let enqueue/status continue while checks and owner refreshes wait. */
export async function runQueue(context: DeliveryContext, options: QueueOptions) {
  const at = await location(context, options);
  const initial = read(at);
  if (initial.entries.length === 0 && drained(initial)) return queueStatus(context, options);
  // Authenticate even when a resumed run only has cleanup left.
  await queuePr(context, initial.entries[0]!.prNumber, initial.entries[0]!.issueNumber);
  ensurePrivateDirectoryDurably(at.directory);
  const update = <T>(operation: (q: Queue) => T) =>
    withLock(at.path, {
      operation: () => {
        const q = read(at);
        const result = operation(q);
        save(at, q);
        return result;
      },
    });
  const remoteRef = async (entry: QueueEntry) => {
    try {
      const result = (await context.clients.rest.git.getRef({ ...context.repo, ref: ref(entry) })).data;
      if (
        result.ref !== `refs/${ref(entry)}` ||
        result.object.type !== 'commit' ||
        !Sha.safeParse(result.object.sha).success
      )
        throw new DeliveryError('Queue ref identity is incomplete.');
      return result.object.sha;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) return null;
      throw error;
    }
  };
  const base = async () => {
    const result = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${at.baseRef}` })).data;
    if (result.ref !== `refs/heads/${at.baseRef}` || result.object.type !== 'commit')
      throw new DeliveryError('Queue base ref identity is incomplete.');
    return Sha.parse(result.object.sha);
  };
  const comments = async (entry: QueueEntry) => {
    const all: { id: number; body?: string | null; user?: { login: string } | null }[] = [];
    for (let page = 1; ; page++) {
      const result = await context.clients.rest.issues.listComments({
        ...context.repo,
        issue_number: entry.prNumber,
        per_page: 100,
        page,
      });
      all.push(...result.data);
      if (result.data.length < 100) return all;
      if (page >= 100) throw new DeliveryError('Queue diagnostic comment pagination exceeds its bound.');
    }
  };
  const reconcile = async () => {
    const q = read(at),
      pending = q.pending;
    if (!pending) return;
    const entry = q.entries.find((e) => e.id === pending.entryId);
    if (!entry) throw new DeliveryError('Pending queue entry is missing.');
    if (pending.kind === 'ref') {
      if ((await remoteRef(entry)) !== pending.after)
        throw new DeliveryError(
          'Queue ref acknowledgement is unknown; read-only reconciliation did not establish the intended outcome. No retry was sent.',
        );
      await update((current) => {
        const e = current.entries.find((e) => e.id === entry.id)!;
        if (pending.after === null) delete e.published;
        else e.published = pending.after;
        delete current.pending;
      });
    } else if (pending.kind === 'comment') {
      const author = await context.clients.authenticatedAuthor!();
      const matches = (await comments(entry)).filter(
        (c) =>
          c.body?.includes(pending.body.split('\n')[0]!) &&
          c.user?.login.toLowerCase() === author.actorLogin.toLowerCase(),
      );
      if (
        matches.length !== 1 ||
        pending.prId !== entry.prId ||
        author.actorLogin.toLowerCase() !== pending.actor.toLowerCase()
      )
        throw new DeliveryError('Queue comment acknowledgement is unknown; no duplicate comment was sent.');
      const native = (await context.clients.rest.issues.getComment({ ...context.repo, comment_id: matches[0]!.id }))
        .data;
      if (
        native.id !== matches[0]!.id ||
        native.body !== pending.body ||
        native.user?.login.toLowerCase() !== pending.actor.toLowerCase() ||
        new URL(native.issue_url).pathname.toLowerCase() !==
          `/repos/${context.repo.owner}/${context.repo.repo}/issues/${entry.prNumber}`.toLowerCase() ||
        native.updated_at !== native.created_at
      )
        throw new DeliveryError('Queue authored comment target/body/edit readback changed; no duplicate was sent.');
      const proof = await context.clients.graphql<{ node: unknown }>(
        `query DeliveryQueueApprovalNode($id:ID!){node(id:$id){... on IssueComment{${approvalFields}}}}`,
        { id: native.node_id },
      );
      const edit = NativeCommentEdit.safeParse(proof.node);
      if (
        !edit.success ||
        edit.data.id !== native.node_id ||
        edit.data.lastEditedAt !== null ||
        edit.data.editor !== null ||
        edit.data.isMinimized
      )
        throw new DeliveryError('Queue authored comment native edit readback changed; no duplicate was sent.');
      await update((current) => {
        const e = current.entries.find((e) => e.id === entry.id)!;
        if (e.notice?.key !== pending.key || e.notice.body !== pending.body)
          throw new DeliveryError('Pending queue notice identity changed.');
        e.notified.push(pending.key);
        delete e.notice;
        delete current.pending;
      });
    } else {
      const { pr } = await queuePr(context, entry.prNumber, entry.issueNumber);
      if (
        pr.node_id !== entry.prId ||
        pr.base.ref !== at.baseRef ||
        !pr.merged ||
        pr.state !== 'closed' ||
        pr.head.sha !== pending.head ||
        !Sha.safeParse(pr.merge_commit_sha).success
      )
        throw new DeliveryError('Queue merge acknowledgement is unknown; no merge retry was sent.');
      const commit = (await context.clients.rest.git.getCommit({ ...context.repo, commit_sha: pr.merge_commit_sha! }))
        .data;
      if (
        commit.sha !== pr.merge_commit_sha ||
        commit.parents.length !== 1 ||
        commit.parents[0]?.sha !== pending.base ||
        commit.tree.sha !== pending.tree ||
        (await base()) !== commit.sha
      ) {
        const reason =
          'Unexpected squash parent/tree or current main mismatch after merge. Queue halted; no rollback is attempted.';
        await update((current) => {
          current.halted = reason;
        });
        throw new DeliveryError(reason);
      }
      await update((current) => {
        const e = current.entries.find((e) => e.id === entry.id)!;
        const grant = current.grants.find((g) => g.id === pending.grantId);
        if (
          !grant ||
          grant.bodyDigest !== pending.grantDigest ||
          e.grantId !== grant.id ||
          grant.members[grant.consumed]?.entryId !== e.id
        )
          throw new DeliveryError('Pending merge approval binding disagrees with the consumed queue prefix.');
        e.merge = { sha: commit.sha, tree: commit.tree.sha };
        transition(e, 'merged');
        grant.consumed++;
        delete current.pending;
      });
    }
  };
  const flushNotice = async (id: string) => {
    const entry = read(at).entries.find((e) => e.id === id)!;
    if (!entry.notice) return;
    const author = await context.clients.authenticatedAuthor!();
    const pending = {
      kind: 'comment' as const,
      entryId: id,
      ...entry.notice,
      actor: author.actorLogin,
      prId: entry.prId,
    };
    const matches = (await comments(entry)).filter(
      (c) =>
        c.body?.includes(pending.body.split('\n')[0]!) &&
        c.user?.login.toLowerCase() === author.actorLogin.toLowerCase(),
    );
    await update((q) => {
      if (q.pending) throw new DeliveryError('Another queue mutation must be reconciled first.');
      q.pending = pending;
    });
    if (!matches.length)
      await context.clients.rest.issues.createComment({
        ...context.repo,
        issue_number: entry.prNumber,
        body: pending.body,
      });
    await reconcile();
  };
  const setState = async (id: string, state: QueueEntry['state'], reason?: string) => {
    await flushNotice(id);
    await update((q) =>
      transition(
        q.entries.find((e) => e.id === id)!,
        state,
        reason,
      ),
    );
    await flushNotice(id);
  };
  return withLock(`${at.path}.driver`, {
    timeout: 200,
    operation: async () => {
      const writerRoot = read(at).writerRoot;
      if (gitCommonDir(writerRoot) !== at.common)
        throw new DeliveryError('Queue process lease root no longer belongs to the canonical Git common directory.');
      return withRuntimeSetupWriter(
        writerRoot,
        async (runner) => {
          if (read(at).writerRoot !== writerRoot)
            throw new DeliveryError(
              'Queue process lease root changed before writer claim; resume with its current root.',
            );
          runner.bindCapturedOutput(digestValue({ binding: at.binding, invocation: randomUUID() }));
          if (read(at).halted) throw new DeliveryError(read(at).halted!);
          await reconcile();
          const store = join(at.directory, 'objects.git');
          const bounds = {
            maxAggregateRssBytes: 3 * 1024 ** 3,
            maxNewOutputBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1024 ** 3,
            outputRoots: [at.directory],
          };
          const identity = () => {
            const owned = read(at).store;
            if (!owned || owned.dev === null || owned.ino === null)
              throw new DeliveryError('Queue object-store creation ownership is unresolved.');
            const stat = lstatSync(store);
            if (
              !stat.isDirectory() ||
              stat.isSymbolicLink() ||
              (stat.mode & 0o022) !== 0 ||
              (process.getuid !== undefined && stat.uid !== process.getuid()) ||
              stat.dev !== owned.dev ||
              stat.ino !== owned.ino ||
              assertPrivateFile(join(store, 'ai-delivery-owner'), { maxBytes: 128 }).toString('utf8') !== owned.id
            )
              throw new DeliveryError('Queue object-store identity changed; cleanup refused.');
            return owned;
          };
          const cleanup = async () => {
            runner.assertQuiescent();
            if (!read(at).store) return;
            if (existsSync(store)) {
              identity();
              await update((q) => {
                q.store!.removing = true;
              });
              rmSync(store, { recursive: true });
            } else if (!read(at).store?.removing)
              throw new DeliveryError('Queue object store disappeared without cleanup intent.');
            if (existsSync(store)) throw new DeliveryError('Queue object-store cleanup absence is unconfirmed.');
            await update((q) => {
              delete q.store;
            });
          };
          const command = async (args: string[], token?: string) => {
            const environment = gitEnvironment();
            // Only the fixed system executable and owned bare store are used; no target config or checkout is loaded.
            environment.PATH = '/usr/bin:/bin';
            if (token !== undefined) {
              environment.GIT_CONFIG_COUNT = '2';
              environment.GIT_CONFIG_KEY_0 = 'credential.helper';
              environment.GIT_CONFIG_VALUE_0 = '';
              environment.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
              environment.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
            }
            environment.GIT_AUTHOR_NAME = 'ai-delivery queue';
            environment.GIT_AUTHOR_EMAIL = 'queue@ai-delivery.invalid';
            environment.GIT_COMMITTER_NAME = environment.GIT_AUTHOR_NAME;
            environment.GIT_COMMITTER_EMAIL = environment.GIT_AUTHOR_EMAIL;
            environment.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
            environment.GIT_COMMITTER_DATE = environment.GIT_AUTHOR_DATE;
            const out = await runner.run(
              [
                GIT_EXECUTABLE,
                ...GIT_INERT_ARGUMENTS,
                '-c',
                'commit.gpgSign=false',
                '-c',
                'protocol.ext.allow=never',
                ...args,
              ],
              bounds,
              runner.signal,
              environment,
              at.directory,
            );
            return out.toString('utf8').trim();
          };
          const ensureStore = async () => {
            if (read(at).store?.removing) await cleanup();
            if (read(at).store) {
              identity();
              return;
            }
            if (existsSync(store)) throw new DeliveryError('Unowned queue object store exists.');
            await update((q) => {
              q.store = { id: randomUUID(), dev: null, ino: null, removing: false };
            });
            ensurePrivateDirectoryDurably(store);
            writeFileSync(join(store, 'ai-delivery-owner'), read(at).store!.id, { mode: 0o600, flag: 'wx' });
            const stat = lstatSync(store);
            await update((q) => {
              q.store!.dev = stat.dev;
              q.store!.ino = stat.ino;
            });
            await command(['init', '--bare', '--quiet', '--template=', store]);
          };
          const remote = `https://github.com/${context.config.repository}.git`;
          const fetch = async (...shas: string[]) => {
            await ensureStore();
            await githubClients.withAuthorGitToken(context.clients, (token) =>
              command(
                [
                  '--git-dir',
                  store,
                  'fetch',
                  '--quiet',
                  '--no-tags',
                  '--no-write-fetch-head',
                  remote,
                  ...new Set(shas),
                ],
                token,
              ),
            );
          };
          const publish = async (entry: QueueEntry, after: string | null) => {
            const before = await remoteRef(entry);
            if (before !== (entry.published ?? null))
              throw new DeliveryError('Queue ref ownership changed; expected-ref lease refused.');
            if (before === after) return;
            await update((q) => {
              q.pending = { kind: 'ref', entryId: entry.id, before, after };
            });
            await githubClients.withAuthorGitToken(context.clients, (token) =>
              command(
                [
                  '--git-dir',
                  store,
                  'push',
                  '--porcelain',
                  `--force-with-lease=refs/${ref(entry)}:${before ?? ''}`,
                  remote,
                  `${after ?? ''}:refs/${ref(entry)}`,
                ],
                token,
              ),
            );
            await reconcile();
          };
          const remove = async (entry: QueueEntry, reason: string) => {
            await setState(entry.id, 'removed', reason);
          };
          let lastProgress = '',
            pollMs = 1000;
          const started = Date.now();
          const progress = async (q: Queue, reason: string) => {
            const observation = {
              completed: q.entries.filter((e) => !active(e)).length,
              remaining: q.entries.filter(active).length,
              elapsedMs: Date.now() - started,
              reason,
            };
            const current = JSON.stringify({ entries: q.entries.map((e) => [e.prNumber, e.state, e.head]), reason });
            if (current !== lastProgress) {
              process.stderr.write(`${JSON.stringify({ stage: 'merge-queue', ...observation })}\n`);
              lastProgress = current;
              pollMs = 1000;
            } else {
              pollMs = Math.min(30000, pollMs * 2);
            }
            await options.onProgress?.(observation);
          };
          try {
            for (;;) {
              runner.signal.throwIfAborted();
              await runner.checkResources();
              await reconcile();
              const q = read(at);
              for (const e of q.entries) await flushNotice(e.id);
              // Cleanup is itself checkpointed and is completed before another PR can merge.
              for (const e of q.entries.filter((e) => !active(e))) {
                if (e.published) {
                  await ensureStore();
                  await publish(e, null);
                }
              }
              let entries = read(at).entries.filter(active);
              if (!entries.length) {
                await cleanup();
                return queueStatus(context, options);
              }
              const baseSha = await base();
              const snapshots = new Map<string, Awaited<ReturnType<typeof queuePr>>['pr']>();
              for (const old of entries)
                snapshots.set(old.id, (await queuePr(context, old.prNumber, old.issueNumber)).pr);
              const obsolete = entries.find((e) => {
                const pr = snapshots.get(e.id)!;
                return pr.state !== 'open' || pr.merged || pr.draft;
              });
              if (obsolete) {
                await remove(obsolete, 'Native PR is no longer open and ready.');
                continue;
              }
              const decision = await chooseApproval(context, read(at), entries[0]!, at.repositoryId);
              for (const diagnostic of decision.diagnostics) {
                const id = entries[0]!.id;
                await flushNotice(id);
                await update((q) =>
                  notice(
                    q.entries.find((e) => e.id === id)!,
                    `approval-${digestValue(diagnostic).slice(7)}`,
                    `Approval ${diagnostic.id} ignored: ${diagnostic.reason}`,
                  ),
                );
                await flushNotice(id);
              }
              if (!decision.grant) {
                for (const e of entries) await setState(e.id, 'needs-approval', approvalWait(context, decision.reason));
                await progress(read(at), decision.reason);
                await delay(pollMs, undefined, { signal: runner.signal });
                continue;
              }
              const grant = decision.grant;
              await update((q) => {
                if (!q.grants.some((g) => g.id === grant.id)) q.grants.push(grant);
                for (const member of grant.members.slice(grant.consumed))
                  q.entries.find((e) => e.id === member.entryId)!.grantId = grant.id;
              });
              const authorized = grant.members.length - grant.consumed;
              for (const e of entries.slice(authorized)) await setState(e.id, 'needs-approval', approvalWait(context));
              entries = entries.slice(0, authorized);
              const rebuildingStore = !existsSync(store);
              const prefixInputs: { id: string; head: string }[] = [];
              const needsObjects = entries.some((entry) => {
                prefixInputs.push({ id: entry.id, head: snapshots.get(entry.id)!.head.sha });
                return (
                  !entry.prediction ||
                  entry.prediction.inputs !== digestValue({ base: baseSha, prefix: prefixInputs }) ||
                  (rebuildingStore && entry.published !== entry.prediction.sha)
                );
              });
              if (needsObjects)
                await fetch(
                  baseSha,
                  ...[...snapshots.values()].map((pr) => pr.head.sha),
                  ...entries.flatMap((e) => (e.published ? [e.published] : [])),
                );
              let parent = baseSha;
              const prefix: { id: string; head: string }[] = [];
              let rebuilt = false;
              for (const old of entries) {
                const pr = snapshots.get(old.id)!;
                if (pr.node_id !== old.prId || pr.base.ref !== at.baseRef)
                  throw new DeliveryError('Queued native PR identity/base changed.');
                if (pr.state !== 'open' || pr.merged || pr.draft) {
                  await remove(old, 'Native PR is no longer open and ready.');
                  rebuilt = true;
                  break;
                }
                prefix.push({ id: old.id, head: pr.head.sha });
                const inputs = digestValue({ base: baseSha, prefix });
                const entry = read(at).entries.find((e) => e.id === old.id)!;
                if (
                  !entry.prediction ||
                  entry.prediction.inputs !== inputs ||
                  (rebuildingStore && entry.published !== entry.prediction.sha)
                ) {
                  let tree: string;
                  try {
                    tree = (
                      await command([
                        '--git-dir',
                        store,
                        'merge-tree',
                        '--write-tree',
                        '-z',
                        '--name-only',
                        parent,
                        pr.head.sha,
                      ])
                    ).split('\0')[0]!;
                  } catch (error) {
                    const text = error instanceof Error ? error.message : String(error);
                    const digest = /Command output (sha256:[a-f0-9]{64})/u.exec(text)?.[1];
                    if (!digest || !/exit 1\b/u.test(text)) throw error;
                    const output = readRepositoryCommandOutput({
                      gitCommonDir: gitCommonDir(options.root),
                      digest,
                    }).toString('utf8');
                    if (!/^[a-f0-9]{40}\0/u.test(output)) throw error;
                    const parts = output.split('\0'),
                      end = parts.indexOf('', 1);
                    const files = parts
                      .slice(1, end < 0 ? undefined : end)
                      .filter(Boolean)
                      .slice(0, 100)
                      .map((s) => JSON.stringify(s))
                      .join(', ')
                      .slice(0, 8192);
                    await remove(entry, `Merge conflict in ${files || 'unresolved paths'}.`);
                    rebuilt = true;
                    break;
                  }
                  Sha.parse(tree);
                  const sha = Sha.parse(
                    await command([
                      '--git-dir',
                      store,
                      'commit-tree',
                      tree,
                      '-p',
                      parent,
                      '-m',
                      `ai-delivery queue ${inputs}`,
                    ]),
                  );
                  await update((current) => {
                    const e = current.entries.find((e) => e.id === entry.id)!;
                    e.head = pr.head.sha;
                    e.prediction = { base: baseSha, parent, sha, tree, inputs };
                  });
                  await setState(entry.id, 'verifying');
                }
                const predicted = read(at).entries.find((e) => e.id === entry.id)!;
                if (predicted.published !== predicted.prediction!.sha) {
                  await publish(predicted, predicted.prediction!.sha);
                  await progress(
                    read(at),
                    `Published prediction for PR #${predicted.prNumber} at ${predicted.prediction!.sha}.`,
                  );
                }
                parent = predicted.prediction!.sha;
              }
              if (rebuilt) continue;
              if (
                JSON.stringify(
                  read(at)
                    .entries.filter(active)
                    .slice(0, entries.length)
                    .map((e) => e.id),
                ) !== JSON.stringify(entries.map((e) => e.id))
              )
                continue;
              let waitReason = '';
              const passed = new Set<string>();
              for (const queued of entries) {
                const old = read(at).entries.find((e) => e.id === queued.id)!;
                const prediction = old.prediction!;
                if ((await remoteRef(old)) !== prediction.sha)
                  throw new DeliveryError('Published queue ref moved outside its owner.');
                const checks = await queueChecks(context, at.baseRef, prediction.sha);
                if (checks.state === 'failed') {
                  await remove(old, checks.reason);
                  rebuilt = true;
                  break;
                }
                if (checks.state === 'passed') passed.add(old.id);
                // A native eligibility wait is not new queue readiness on every poll.
                if (checks.state !== 'passed' || old.state !== 'waiting')
                  await setState(old.id, checks.state === 'passed' ? 'ready' : 'verifying', checks.reason);
                if (checks.state !== 'passed') waitReason ||= checks.reason;
              }
              if (rebuilt) continue;
              const first = read(at).entries.find(active)!;
              if (first.state === 'ready' || (first.state === 'waiting' && passed.has(first.id))) {
                const prediction = first.prediction!;
                try {
                  await mergePr(
                    context,
                    {
                      issueNumber: first.issueNumber,
                      prNumber: first.prNumber,
                      reviewedHeadSha: first.head,
                      strategy: 'squash',
                    },
                    {
                      expectedBase: prediction.base,
                      checkProof: async () => {
                        const checks = await queueChecks(context, at.baseRef, prediction.sha);
                        if (checks.state !== 'passed' || (await remoteRef(first)) !== prediction.sha)
                          throw new DeliveryError('Queue proof changed before merge.');
                        const approval = await chooseApproval(context, read(at), first, at.repositoryId);
                        if (approval.grant?.id !== grant.id || approval.grant.bodyDigest !== grant.bodyDigest) {
                          await setState(
                            first.id,
                            'needs-approval',
                            approvalWait(context, approval.reason || 'Approval binding changed before merge.'),
                          );
                          throw new DeliveryError('Standing approval changed before merge.');
                        }
                        // Native eligibility has now advanced; notify before the final base read.
                        if (first.state === 'waiting') await setState(first.id, 'ready', checks.reason);
                      },
                      beforeMutation: async () => {
                        runner.signal.throwIfAborted();
                        if (Date.now() >= Date.parse(grant.expiresAt))
                          throw new DeliveryError('Standing approval expired before merge.');
                        await update((current) => {
                          current.pending = {
                            kind: 'merge',
                            entryId: first.id,
                            head: first.head,
                            base: prediction.base,
                            tree: prediction.tree,
                            grantId: grant.id,
                            grantDigest: grant.bodyDigest,
                          };
                        });
                      },
                    },
                  );
                } catch (error) {
                  if (read(at).pending) throw error;
                  const reason = error instanceof Error ? error.message : String(error);
                  if (
                    !/merge eligibility|review eligibility|head\/base changed|base moved|reviewed head differs|proof changed|native blockers|standing approval/iu.test(
                      reason,
                    )
                  )
                    throw error;
                  waitReason = reason;
                  if (read(at).entries.find((e) => e.id === first.id)!.state !== 'needs-approval')
                    await setState(first.id, 'waiting', reason);
                }
                if (read(at).pending) {
                  await reconcile();
                  continue;
                }
              }
              await progress(read(at), waitReason || 'Waiting for current native checks, review or owner refresh.');
              await delay(pollMs, undefined, { signal: runner.signal });
            }
          } finally {
            // Keep prediction objects during a pending mutation; an explicit resume reconciles before reuse/cleanup.
            if (!read(at).pending) await cleanup();
          }
        },
        {
          bounds: {
            maxAggregateRssBytes: 3 * 1024 ** 3,
            maxNewOutputBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1024 ** 3,
            outputRoots: [at.directory],
          },
          maxCapturedOutputBytes: 8 * 1024 ** 2,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    },
  });
}
