import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';

import type { NativePointValue } from '../github/nativeIssueMetadata.js';

export interface AgentReadinessResult {
  failures: {
    code: ReadinessFailureCode;
    message: string;
  }[];
  ready: boolean;
}

export type ReadinessFailureCode =
  | 'acceptance-criteria'
  | 'blocked'
  | 'evidence'
  | 'outcome'
  | 'points'
  | 'scope'
  | 'tracking-parent'
  | 'unresolved'
  | 'verification';

export function evaluateAgentReadiness(input: {
  blockedBy?: number[];
  body: string;
  points?: NativePointValue;
  repoRoot: string | undefined;
  title: string;
  trackingParent?: boolean;
}): AgentReadinessResult {
  const failures: AgentReadinessResult['failures'] = [];
  const body = input.body.trim();
  const scope = extractScopePaths(body);

  if (!hasSubstantiveOutcome(body)) {
    failures.push({
      code: 'outcome',
      message: 'Add a substantive Outcome or Problem section.',
    });
  }

  const acceptanceCriteria = extractCheckboxItems(extractSection(body, 'Acceptance Criteria'));
  if (acceptanceCriteria.length < 2 || acceptanceCriteria.length > 5) {
    failures.push({
      code: 'acceptance-criteria',
      message: 'Declare two to five checkbox acceptance criteria.',
    });
  }

  if (!hasExecutableVerification(body)) {
    failures.push({
      code: 'verification',
      message: 'Include an executable verification command in inline or fenced code.',
    });
  }

  if (scope.length === 0 || scope.some((scopePath) => !isRepositoryPath(scopePath, input.repoRoot))) {
    failures.push({
      code: 'scope',
      message: 'Declare scope paths that exist in the repository.',
    });
  }

  if ((input.blockedBy?.length ?? 0) > 0) {
    failures.push({
      code: 'blocked',
      message: `Resolve native blocked-by issue${input.blockedBy?.length === 1 ? '' : 's'} before autonomous development.`,
    });
  }

  if (requiresRepositoryEvidence({ body, scope }) && !hasRepositoryEvidence(body, input.repoRoot)) {
    failures.push({
      code: 'evidence',
      message: 'Add repository-backed current-state evidence for this scope.',
    });
  }

  if (input.trackingParent === true) {
    failures.push({
      code: 'tracking-parent',
      message: 'Dispatch an executable sub-issue instead of the tracking parent.',
    });
  } else if (input.points === undefined) {
    failures.push({
      code: 'points',
      message: 'Set configured native Points before autonomous development.',
    });
  }

  if (hasUnresolvedMarker(body)) {
    failures.push({
      code: 'unresolved',
      message: 'Resolve TODO, TBD, policy-choice, or architectural-fork markers.',
    });
  }

  return { failures, ready: failures.length === 0 };
}

function extractCheckboxItems(section: string): string[] {
  return section
    .split(/\r?\n/u)
    .map((line) => {
      const candidate = line.trimStart();
      if (!['*', '+', '-'].includes(candidate.charAt(0))) {
        return undefined;
      }
      const checkbox = candidate.slice(1).trimStart();
      if (
        checkbox.length < 4 ||
        !checkbox.startsWith('[') ||
        ![' ', 'x', 'X'].includes(checkbox.charAt(1)) ||
        checkbox.charAt(2) !== ']' ||
        ![' ', '\t'].includes(checkbox.charAt(3))
      ) {
        return undefined;
      }
      return checkbox.slice(4).trim();
    })
    .filter((item): item is string => item !== undefined && item.length > 0);
}

function extractFencedCode(body: string): string[] {
  const blocks: string[] = [];
  let current: null | string[] = null;
  for (const line of body.split(/\r?\n/u)) {
    if (current !== null) {
      if (line.trim() === '```') {
        blocks.push(current.join('\n'));
        current = null;
      } else {
        current.push(line);
      }
      continue;
    }

    const candidate = line.trimStart();
    const indentation = line.length - candidate.length;
    if (indentation > 3 || !candidate.startsWith('```')) {
      continue;
    }
    const info = candidate.slice(3).trim().toLowerCase();
    if (['', 'bash', 'console', 'sh', 'shell', 'zsh'].includes(info)) {
      current = [];
    }
  }
  return blocks;
}

function extractInlineCode(body: string): string[] {
  return Array.from(body.matchAll(/`([^`\r\n]+)`/gu), (match) => match[1]?.trim() ?? '').filter(Boolean);
}

function extractScopePaths(body: string): string[] {
  const section = extractSection(body, 'Scope');
  // Exclude complete monetary literals only; every other inline value remains a path candidate.
  return extractInlineCode(section).filter(
    (candidate) => !/^\$\d+(?:,\d{3})*(?:\.\d{1,2})?(?:\s*[/–-]\s*\$\d+(?:,\d{3})*(?:\.\d{1,2})?)*$/u.test(candidate),
  );
}

function extractSection(body: string, heading: string): string {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => readMarkdownHeading(line)?.toLowerCase() === heading.toLowerCase());
  if (start === -1) return '';

  const content: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (readMarkdownHeading(line) !== null) break;
    content.push(line);
  }
  return content.join('\n').trim();
}

function hasExecutableVerification(body: string): boolean {
  const executableCommands = new Set([
    'bash',
    'cargo',
    'git',
    'go',
    'make',
    'node',
    'npm',
    'npx',
    'pnpm',
    'python',
    'python3',
    'sh',
    'tsc',
    'tsx',
    'zsh',
  ]);
  const code = [...extractInlineCode(body), ...extractFencedCode(body)];
  return code.some((value) =>
    value.split(/\r?\n/u).some((line) => {
      const command = line.trimStart().split(/\s/u, 1)[0];
      return command !== undefined && executableCommands.has(command);
    }),
  );
}

function hasRepositoryEvidence(body: string, repoRoot: string | undefined): boolean {
  const evidenceSource = body.replace(extractSection(body, 'Scope'), '');
  if (/\b[0-9a-f]{40}:[^\s`]+/iu.test(evidenceSource) || /\/blob\/[0-9a-f]{40}\//iu.test(evidenceSource)) {
    return true;
  }
  return extractInlineCode(evidenceSource).some((candidate) => isRepositoryPath(candidate, repoRoot));
}

function hasSubstantiveOutcome(body: string): boolean {
  const outcome = extractSection(body, 'Outcome');
  const problem = extractSection(body, 'Problem');
  return [outcome, problem].some((section) => stripMarkdown(section).length >= 24);
}

function hasUnresolvedMarker(body: string): boolean {
  return /\b(?:TODO|TBD|policy choice|architectural fork)\b/iu.test(body);
}

function isAggregateScope(scopePath: string): boolean {
  const normalized = normalizeScopePath(scopePath);
  if (normalized === null) return false;
  return normalized.length === 0 || ['.', 'apps', 'packages', 'plugins'].includes(normalized);
}

function isRepositoryPath(candidate: string, repoRoot: string | undefined): boolean {
  const path = normalizeScopePath(candidate);
  if (path === null) return false;
  if (repoRoot === undefined) return true;
  const resolved = normalize(join(repoRoot, path));
  const normalizedRoot = normalize(repoRoot);
  return (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`)) && existsSync(resolved);
}

function normalizeScopePath(candidate: string): null | string {
  const raw = candidate.replace(/(?::\d+(?::\d+)?)$/u, '').replace(/\\/gu, '/');
  if (raw.startsWith('/') || raw.split('/').includes('..')) return null;
  return raw
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
}

function readMarkdownHeading(line: string): null | string {
  let index = 0;
  while (line.charAt(index) === ' ' && index < 4) {
    index += 1;
  }
  if (index > 3 || line.charAt(index) !== '#') {
    return null;
  }

  let markerCount = 0;
  while (line.charAt(index + markerCount) === '#' && markerCount < 7) {
    markerCount += 1;
  }
  if (markerCount === 0 || markerCount > 6 || ![' ', '\t'].includes(line.charAt(index + markerCount))) {
    return null;
  }
  return line.slice(index + markerCount).trim();
}

function requiresRepositoryEvidence({ body, scope }: { body: string; scope: string[] }): boolean {
  const ownershipRoots = new Set(
    scope
      .map((scopePath) => normalizeScopePath(scopePath))
      .filter((scopePath): scopePath is string => scopePath !== null)
      .map((scopePath) => scopePath.split('/').filter(Boolean).slice(0, 2).join('/'))
      .filter(Boolean),
  );
  return (
    scope.some(isAggregateScope) ||
    ownershipRoots.size > 1 ||
    /\b(?:migration|production|data|contract-sensitive)\b/iu.test(body)
  );
}

function stripMarkdown(value: string): string {
  return value
    .replace(/[`*_>#-]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
