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
const Entry = z.strictObject({
  id: z.string().uuid(),
  issueNumber: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  prId: z.string().min(1),
  head: Sha,
  state: z.enum(['waiting', 'verifying', 'ready', 'merged', 'removed']),
  reason: z.string().optional(),
  prediction: Prediction.optional(),
  published: Sha.optional(),
  merge: z.strictObject({ sha: Sha, tree: Sha }).optional(),
  comment: z.string().optional(),
});
type QueueEntry = z.infer<typeof Entry>;
const Pending = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ref'), entryId: z.uuid(), before: Sha.nullable(), after: Sha.nullable() }),
  z.strictObject({ kind: z.literal('merge'), entryId: z.uuid(), head: Sha, base: Sha, tree: Sha }),
  z.strictObject({ kind: z.literal('comment'), entryId: z.uuid(), body: z.string() }),
]);
const Record = z.strictObject({
  schemaVersion: z.literal('ai-delivery.merge-queue@1'),
  binding: z.string(),
  baseRef: z.string().min(1),
  writerRoot: z.string().refine(isAbsolute),
  entries: z.array(Entry),
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
  !q.pending && !q.store && !q.halted && q.entries.every((e) => !active(e) && !e.published && !e.comment);
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
      schemaVersion: 'ai-delivery.merge-queue@1',
      binding: at.binding,
      baseRef: at.baseRef,
      writerRoot: at.writerRoot,
      entries: [],
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
      const entry = existing ?? {
        id: randomUUID(),
        prNumber: pr.number,
        issueNumber,
        prId: pr.node_id,
        head: pr.head.sha,
        state: 'waiting' as const,
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
        (c) => c.body === pending.body && c.user?.login.toLowerCase() === author.actorLogin.toLowerCase(),
      );
      if (matches.length !== 1)
        throw new DeliveryError('Queue diagnostic comment acknowledgement is unknown; no duplicate comment was sent.');
      await update((current) => {
        delete current.entries.find((e) => e.id === entry.id)!.comment;
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
        e.state = 'merged';
        e.merge = { sha: commit.sha, tree: commit.tree.sha };
        delete e.reason;
        delete current.pending;
      });
    }
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
            await update((q) => {
              const e = q.entries.find((e) => e.id === entry.id)!;
              e.state = 'removed';
              e.reason = reason;
              e.comment = `<!-- ai-delivery:merge-queue:${entry.id} -->\nRemoved from the host-local merge queue: ${reason}`;
            });
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
              // Cleanup is itself checkpointed and is completed before another PR can merge.
              for (const e of q.entries.filter((e) => !active(e))) {
                if (e.published) {
                  await ensureStore();
                  await publish(e, null);
                }
                if (e.comment) {
                  await update((current) => {
                    current.pending = { kind: 'comment', entryId: e.id, body: e.comment! };
                  });
                  await context.clients.rest.issues.createComment({
                    ...context.repo,
                    issue_number: e.prNumber,
                    body: e.comment,
                  });
                  await reconcile();
                }
              }
              const entries = read(at).entries.filter(active);
              if (!entries.length) {
                await cleanup();
                return queueStatus(context, options);
              }
              const baseSha = await base();
              const snapshots = new Map<string, Awaited<ReturnType<typeof queuePr>>['pr']>();
              for (const old of entries)
                snapshots.set(old.id, (await queuePr(context, old.prNumber, old.issueNumber)).pr);
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
                    e.state = 'verifying';
                    delete e.reason;
                  });
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
                    .map((e) => e.id),
                ) !== JSON.stringify(entries.map((e) => e.id))
              )
                continue;
              let waitReason = '';
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
                await update((current) => {
                  const e = current.entries.find((e) => e.id === old.id)!;
                  e.state = checks.state === 'passed' ? 'ready' : 'verifying';
                  e.reason = checks.reason;
                });
                if (checks.state !== 'passed') waitReason ||= checks.reason;
              }
              if (rebuilt) continue;
              const first = read(at).entries.find(active)!;
              if (first.state === 'ready') {
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
                      },
                      beforeMutation: async () => {
                        await update((current) => {
                          current.pending = {
                            kind: 'merge',
                            entryId: first.id,
                            head: first.head,
                            base: prediction.base,
                            tree: prediction.tree,
                          };
                        });
                      },
                    },
                  );
                } catch (error) {
                  if (read(at).pending) throw error;
                  const reason = error instanceof Error ? error.message : String(error);
                  if (
                    !/merge eligibility|review eligibility|head\/base changed|base moved|reviewed head differs|proof changed|native blockers/iu.test(
                      reason,
                    )
                  )
                    throw error;
                  waitReason = reason;
                  await update((current) => {
                    const e = current.entries.find((e) => e.id === first.id)!;
                    e.state = 'waiting';
                    e.reason = reason;
                  });
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
