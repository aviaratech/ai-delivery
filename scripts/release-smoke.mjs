#!/usr/bin/env node
// Required before every publish (CONTRIBUTING). 0.3.39 shipped with issue_create broken, so this creates a
// throwaway --draft issue through the packed CLI, reads it back and closes it, using the caller's own GitHub login.
// The close is attempted even after a failed read. Exit 0 and one PASS line, or exit 1 and one FAIL line.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BODY = 'Throwaway release smoke check. scripts/release-smoke.mjs closes it in the same run.';

/** @typedef {{created?: {number?: number}, title?: string, state?: string}} Reply */
/** @param {{cli: (args: string[]) => Reply, version: string, now?: () => Date}} input */
export function releaseSmoke({ cli, version, now = () => new Date() }) {
  const title = `release smoke ${version} ${now().toISOString()}`;
  const failures = [];
  let number;
  try {
    number = cli(['create', '--title', title, '--draft', '--body', BODY])?.created?.number;
    if (!Number.isInteger(number)) throw new Error('create returned no issue number');
    const read = cli(['info', '--issue', String(number)]);
    if (read?.title !== title) throw new Error(`read back "${read?.title}" instead of "${title}"`);
  } catch (error) {
    failures.push(`${number === undefined ? 'create' : `read back #${number}`}: ${error.message}`);
  }
  if (number !== undefined) {
    try {
      const closed = cli(['update', '--issue', String(number), '--state', 'closed', '--close-reason', 'not_planned']);
      if (closed?.state !== 'closed') throw new Error(`state is ${closed?.state}`);
    } catch (error) {
      failures.push(`close #${number}: ${error.message}. Close it by hand.`);
    }
  }
  return failures.length === 0
    ? { ok: true, line: `PASS release smoke ${version}: created, read back and closed #${number}` }
    : { ok: false, line: `FAIL release smoke ${version}: ${failures.join('; ')}` };
}

function main() {
  const args = process.argv.slice(2);
  /** @param {string} name */
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const repo = option('--repo') ?? 'aviaratech/ai-delivery';
  const identity = option('--identity');
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const { version } = /** @type {{ version: string }} */ (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  const work = mkdtempSync(join(tmpdir(), 'release-smoke-'));
  try {
    const [{ filename }] = /** @type {{ filename: string }[]} */ (
      JSON.parse(
        execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], {
          cwd: root,
          encoding: 'utf8',
        }),
      )
    );
    execFileSync('tar', ['-xzf', join(work, filename), '-C', work]);
    const entry = join(work, 'package', 'plugins', 'ai-delivery', 'runtime', 'dist', 'cli.js');
    /** @param {string[]} command */
    const cli = (command) => {
      const run = spawnSync(
        process.execPath,
        [entry, '--repo', repo, ...(identity === undefined ? [] : ['--identity', identity]), ...command],
        { cwd: work, encoding: 'utf8', timeout: 120_000 },
      );
      if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'the CLI failed').trim().split('\n')[0]);
      return /** @type {Reply} */ (JSON.parse(run.stdout));
    };
    const result = releaseSmoke({ cli, version });
    process.stdout.write(`${result.line}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`FAIL release smoke: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
