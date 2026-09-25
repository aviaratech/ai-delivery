import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { digestValue } from './delivery/index.js';
import type { DeliveryContext } from './issue.js';
import { mergeWithExactLease, persistMergedResult } from './pr.js';
import { getIssueWorktreeStrict, updateIssueWorktreeDelivery } from './services/worktreeRegistry.js';
import { cleanupMergedIssueWorktree, prepareIssueWorktree } from './worktree.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture(): Promise<{ root: string; path: string; baseSha: string; headSha: string; headTree: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-pr-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Local Test');
  git(root, 'config', 'user.email', 'local@example.test');
  writeFileSync(join(root, '.gitignore'), '.issue-cli/\n.worktrees/\n');
  writeFileSync(join(root, 'initial.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  const row = await prepareIssueWorktree({ baseRef: 'main', identity: 'author', issueNumber: 17, repoRoot: root });
  writeFileSync(join(row.path, 'feature.txt'), 'feature\n');
  git(row.path, 'add', '.');
  git(row.path, 'commit', '-qm', 'feature');
  return {
    root,
    path: row.path,
    baseSha,
    headSha: git(row.path, 'rev-parse', 'HEAD'),
    headTree: git(row.path, 'rev-parse', 'HEAD^{tree}'),
  };
}

test('exact-lease merge refuses a cleanly mergeable diverged head before GitHub mutation', async () => {
  const state = await fixture();
  try {
    writeFileSync(join(state.root, 'base-only.txt'), 'base change\n');
    git(state.root, 'add', '.');
    git(state.root, 'commit', '-qm', 'base change');
    const divergedBase = git(state.root, 'rev-parse', 'HEAD');
    assert.notEqual(divergedBase, state.baseSha);
    assert.equal(git(state.root, 'merge-tree', '--write-tree', divergedBase, state.headSha).length, 40);
    let remoteCalls = 0;
    const context = {
      root: state.root,
      clients: {
        rest: {
          pulls: {
            get: () => {
              remoteCalls += 1;
            },
          },
        },
      },
    } as unknown as DeliveryContext;
    await assert.rejects(
      mergeWithExactLease(context, {
        baseBranch: 'main',
        baseSha: divergedBase,
        headBranch: 'issue/17',
        headSha: state.headSha,
        headTree: state.headTree,
        prNumber: 21,
        title: 'feature',
        worktreePath: state.path,
      }),
      /ancestor/,
    );
    assert.equal(remoteCalls, 0);
    assert.equal(git(state.root, 'rev-parse', 'main'), divergedBase);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('remote squash recovery persists receipt, repairs registry, and cleans with exact readback', async () => {
  const state = await fixture();
  try {
    await updateIssueWorktreeDelivery({
      branch: 'issue/17',
      issueNumber: 17,
      path: state.path,
      prNumber: 21,
      projectRoot: state.root,
      status: 'pr-published',
    });
    writeFileSync(join(state.root, 'base-only.txt'), 'base change\n');
    git(state.root, 'add', '.');
    git(state.root, 'commit', '-qm', 'base change');
    const baseSha = git(state.root, 'rev-parse', 'HEAD');
    const mergeTree = git(state.root, 'merge-tree', '--write-tree', baseSha, state.headSha);
    assert.notEqual(mergeTree, state.headTree);
    const mergeSha = git(state.root, 'commit-tree', mergeTree, '-p', baseSha, '-m', 'squash feature');
    git(state.root, 'reset', '--hard', mergeSha);
    const evidenceId = digestValue('merge evidence');
    const reviewReceiptId = digestValue('review receipt');
    const content = {
      baseBranch: 'main',
      baseSha,
      evidenceId,
      exactBaseHeadLease: false,
      headBranch: 'issue/17',
      headSha: state.headSha,
      headTree: state.headTree,
      issueNumber: 17,
      prNumber: 21,
      reviewReceiptId,
      schemaVersion: 'ai-delivery.merge-intent@2' as const,
      strategy: 'squash' as const,
    };
    const intent = { ...content, intentId: digestValue(content) };
    let reportedTree = state.headTree;
    const mock = {
      clients: {
        rest: {
          pulls: {
            get: async () => ({
              data: {
                state: 'closed',
                merged_at: '2026-09-24T00:00:00Z',
                merge_commit_sha: mergeSha,
                head: { sha: state.headSha, ref: 'issue/17' },
                base: { ref: 'main' },
              },
            }),
          },
          git: {
            getRef: async ({ ref }: { ref: string }) => {
              if (ref !== 'heads/main') throw Object.assign(new Error('head branch deleted'), { status: 404 });
              return { data: { object: { sha: mergeSha } } };
            },
            getCommit: async () => ({
              data: { sha: mergeSha, tree: { sha: reportedTree }, parents: [{ sha: baseSha }] },
            }),
          },
        },
      },
    };
    const path = join(state.root, '.git', 'ai-delivery', 'merges', '17', `${state.headSha}.json`);
    const input = { branch: 'issue/17', intent, path, worktreePath: state.path, expectedSha: mergeSha };
    await assert.rejects(
      persistMergedResult({ ...mock, root: state.root } as unknown as DeliveryContext, input),
      /Remote merge ref, branch or commit readback/u,
    );
    assert.equal(existsSync(path), false);
    reportedTree = mergeTree;
    await assert.rejects(
      persistMergedResult({ ...mock, root: join(state.root, 'wrong-registry') } as unknown as DeliveryContext, input),
    );
    assert.equal(existsSync(path), false);
    assert.equal(getIssueWorktreeStrict(17, state.root).status, 'pr-published');
    const receipt = await persistMergedResult({ ...mock, root: state.root } as unknown as DeliveryContext, input);
    assert.equal((JSON.parse(readFileSync(path, 'utf8') as string) as { mergeSha: string }).mergeSha, mergeSha);
    assert.equal(getIssueWorktreeStrict(17, state.root).status, 'merged');
    assert.equal(receipt.schemaVersion, 'ai-delivery.merge@3');
    if (receipt.schemaVersion !== 'ai-delivery.merge@3') throw new Error('Expected current merge receipt.');
    const attestation = {
      baseBranch: receipt.baseBranch,
      baseSha: receipt.baseSha,
      headBranch: receipt.headBranch,
      headSha: receipt.headSha,
      mergeSha: receipt.mergeSha,
      mergeTree: receipt.mergeTree,
      remoteBaseSha: mergeSha,
      remoteHeadSha: '0'.repeat(40),
      strategy: receipt.strategy,
    };
    await assert.rejects(
      cleanupMergedIssueWorktree({ issueNumber: 17, repoRoot: state.root, merge: attestation }),
      /attestation/,
    );
    assert.equal(existsSync(state.path), true);
    await cleanupMergedIssueWorktree({
      issueNumber: 17,
      repoRoot: state.root,
      merge: { ...attestation, remoteHeadSha: null },
    });
    assert.equal(existsSync(state.path), false);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('ordinary divergent merge preserves the combined tree through receipt recovery', async () => {
  const state = await fixture();
  try {
    await updateIssueWorktreeDelivery({
      branch: 'issue/17',
      issueNumber: 17,
      path: state.path,
      prNumber: 21,
      projectRoot: state.root,
      status: 'pr-published',
    });
    writeFileSync(join(state.root, 'base-only.txt'), 'base change\n');
    git(state.root, 'add', '.');
    git(state.root, 'commit', '-qm', 'base change');
    const baseSha = git(state.root, 'rev-parse', 'HEAD');
    const mergeTree = git(state.root, 'merge-tree', '--write-tree', baseSha, state.headSha);
    assert.notEqual(mergeTree, state.headTree);
    const mergeSha = git(
      state.root,
      'commit-tree',
      mergeTree,
      '-p',
      baseSha,
      '-p',
      state.headSha,
      '-m',
      'merge feature',
    );
    git(state.root, 'reset', '--hard', mergeSha);
    const content = {
      baseBranch: 'main',
      baseSha,
      evidenceId: digestValue('merge evidence'),
      exactBaseHeadLease: false,
      headBranch: 'issue/17',
      headSha: state.headSha,
      headTree: state.headTree,
      issueNumber: 17,
      prNumber: 21,
      reviewReceiptId: digestValue('review receipt'),
      schemaVersion: 'ai-delivery.merge-intent@2' as const,
      strategy: 'merge' as const,
    };
    const intent = { ...content, intentId: digestValue(content) };
    const mock = {
      clients: {
        rest: {
          pulls: {
            get: async () => ({
              data: {
                state: 'closed',
                merged_at: '2026-09-24T00:00:00Z',
                merge_commit_sha: mergeSha,
                head: { sha: state.headSha, ref: 'issue/17' },
                base: { ref: 'main' },
              },
            }),
          },
          git: {
            getRef: async ({ ref }: { ref: string }) => ({
              data: {
                object: {
                  sha: ref === 'heads/main' ? mergeSha : state.headSha,
                },
              },
            }),
            getCommit: async () => ({
              data: { sha: mergeSha, tree: { sha: mergeTree }, parents: [{ sha: baseSha }, { sha: state.headSha }] },
            }),
          },
        },
      },
    };
    const path = join(state.root, '.git', 'ai-delivery', 'merges', '17', `${state.headSha}.json`);
    const input = { branch: 'issue/17', intent, path, worktreePath: state.path, expectedSha: mergeSha };
    await assert.rejects(
      persistMergedResult({ ...mock, root: join(state.root, 'wrong-registry') } as unknown as DeliveryContext, input),
    );
    assert.equal(getIssueWorktreeStrict(17, state.root).status, 'pr-published');
    const receipt = await persistMergedResult({ ...mock, root: state.root } as unknown as DeliveryContext, input);
    assert.equal(receipt.mergeTree, mergeTree);
    assert.equal(getIssueWorktreeStrict(17, state.root).status, 'merged');
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
