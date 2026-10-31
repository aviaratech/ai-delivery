import type { JournalAttention } from './issueJournal.js';
import type { PrBoardFacts } from './pr.js';
import type { ExecutionContext } from './dispatch.js';
import type { DeliveryContext } from './issue.js';
import type { GitHubClients } from './github/client.js';
import type { ProjectDeliveryConfiguration, ProjectItemObservation } from './github/projectDelivery.js';
import { loadDeliverySettings } from './config/deliveryConfig.js';
import { digestValue } from './delivery/common.js';
import { DeliveryError } from './errors.js';
import { createDeliveryGitHubClients } from './github/client.js';
import { evaluateCommandIdentityPolicy } from './github/commandIdentityPolicy.js';
import {
  getProjectDeliveryConfiguration,
  projectSettingsFromDeliveryConfig,
  readProjectDeliveryItems,
} from './github/projectDelivery.js';
import { loadDeliveryContext } from './issue.js';
import { parseJournalAttention } from './issueJournal.js';
import { hasDeliveryMergeTrailer, hasDeliveryPrMarker, readPrBoardFacts } from './pr.js';

export type DeliveryBoardRequest = { repos: string[]; decisionLabels: string[] };
export type BoardSection = 'humanAttention' | 'readyPrs' | 'blockedPrs' | 'staleIssues';
export interface BoardRow {
  repository: string;
  id: string;
  number: number;
  url: string;
  title: string;
  reasons: string[];
  state?: string;
  updatedAt?: string;
  headSha?: string;
  issueNumber?: number;
}
export interface BoardAttentionRow extends BoardRow {
  request: string | null;
  labels: string[];
  journal: JournalAttention & { commentId: string | null; url: string | null };
}
export interface BoardCoverage {
  status: 'complete' | 'partial' | 'unavailable';
  observed: number;
  unknownRows: BoardRow[];
  reasons: string[];
}
export interface BoardMetric {
  marked: number;
  total: number;
  unknown: number;
  complete: boolean;
  percentage: number | null;
  reasons: string[];
}
export interface BoardRepository {
  repository: string;
  access: 'readable' | 'unreadable' | 'unknown';
  humanAttention: BoardAttentionRow[];
  readyPrs: PrBoardFacts[];
  blockedPrs: PrBoardFacts[];
  staleIssues: BoardRow[];
  coverage: Record<BoardSection, BoardCoverage>;
  diagnostics: Array<{ scope: string; code: string }>;
  metrics: { opened: BoardMetric; merged: BoardMetric };
}
export interface DeliveryBoardResult {
  schemaVersion: 'ai-delivery.board@1';
  collection: { startedAt: string; completedAt: string; asOf: string };
  complete: boolean;
  repositories: BoardRepository[];
}

const boardSections: ReadonlyArray<readonly [BoardSection, string]> = [
  ['humanAttention', 'Human attention'],
  ['readyPrs', 'Ready PRs'],
  ['blockedPrs', 'Blocked PRs'],
  ['staleIssues', 'Stale In Progress issues (72h)'],
];

function singleLine(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, ' ').replace(/[\\`*_[\]<>]/gu, '\\$&');
}
function metricText(value: BoardMetric): string {
  const fraction = `${value.marked}/${value.total}`;
  return value.complete
    ? `${fraction} (${value.percentage === null ? 'n/a' : `${Math.round(value.percentage)}%`})`
    : `${fraction} observed; unknown ${value.unknown}; incomplete`;
}

/** Bound the actual CLI newline and MCP JSON-string transports without changing facts. */
export function renderDeliveryBoard(result: DeliveryBoardResult): string {
  const groups = boardSections.map(([section, heading]) => ({
    section,
    heading,
    repositories: result.repositories.map((repo) => ({
      repo,
      rows: [...repo[section]]
        .sort((a, b) => a.number - b.number)
        .map((row) => {
          const url = row.url.replace(/[\\<>()[\]\s]/gu, (character) => encodeURIComponent(character));
          const reason = row.reasons.length
            ? ` ${row.reasons[0]}${row.reasons.length > 1 ? ` +${row.reasons.length - 1}` : ''}`
            : '';
          return {
            link: `[#${row.number}](${url})${reason}`,
            title: singleLine(row.title).slice(0, 80),
          };
        }),
    })),
  }));
  const count = groups.reduce(
    (total, group) => total + group.repositories.reduce((n, repo) => n + repo.rows.length, 0),
    0,
  );
  const heading = `Delivery board @ ${result.collection.asOf} (${result.complete ? 'complete' : 'partial'})`;
  const metadata = result.repositories.map((repo) => {
    const gaps = boardSections.flatMap(([section]) => {
      const scope = repo.coverage[section];
      return scope.status === 'complete'
        ? []
        : [
            `${section}:${scope.status}, unknown ${scope.unknownRows.length}${scope.reasons[0] ? `, ${scope.reasons[0]}` : ''}`,
          ];
    });
    return `${repo.repository}: ${repo.access}; 7d opened ${metricText(repo.metrics.opened)}, merged ${metricText(repo.metrics.merged)}${gaps.length ? `; ${gaps.join('; ')}` : '; coverage complete'}`;
  });
  function render(titles: boolean, visible: number): string {
    let remaining = visible;
    return [
      heading,
      ...metadata,
      ...groups.map((group) => {
        const lines = group.repositories.flatMap(({ repo, rows }) => {
          if (!rows.length) return [];
          const shown = rows.slice(0, remaining);
          remaining -= shown.length;
          return [
            `${repo.repository}:`,
            ...shown.map((row) => `${row.link}${titles && row.title ? ` ${row.title}` : ''}`),
            ...(shown.length < rows.length ? [`${rows.length - shown.length} rows omitted`] : []),
          ];
        });
        return `${group.heading}\n${lines.length ? lines.join('\n') : 'None observed'}`;
      }),
    ].join('\n');
  }
  function fits(value: string): boolean {
    return Math.max(value.length + 1, JSON.stringify(value).length) <= 3999;
  }
  const titled = render(true, count);
  if (fits(titled)) return titled;
  const links = render(false, count);
  if (fits(links)) return links;
  if (fits(render(false, 0))) {
    let lower = 0,
      upper = count;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (fits(render(false, middle))) lower = middle;
      else upper = middle - 1;
    }
    return render(false, lower);
  }
  // Even repository metadata can exceed the transport budget. Preserve explicit
  // aggregate access/coverage and omissions; full JSON retains every detail.
  return [
    heading,
    `${result.repositories.length} repository details omitted; readable ${result.repositories.filter((repo) => repo.access === 'readable').length}, unreadable ${result.repositories.filter((repo) => repo.access === 'unreadable').length}, unknown ${result.repositories.filter((repo) => repo.access === 'unknown').length}. Per-repository metrics/reasons remain in full JSON.`,
    ...groups.map((group) => {
      const rows = group.repositories.reduce((n, repo) => n + repo.rows.length, 0);
      const scopes = result.repositories.map((repo) => repo.coverage[group.section]);
      return `${group.heading}\n${rows ? `${rows} rows omitted` : 'None observed'}; coverage unavailable ${scopes.filter((scope) => scope.status === 'unavailable').length}, partial ${scopes.filter((scope) => scope.status === 'partial').length}; unknown rows ${scopes.reduce((n, scope) => n + scope.unknownRows.length, 0)}`;
    }),
  ].join('\n');
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const pageLimit = 20;
const retainedLimit = 16 * 1024 * 1024;
const day = 24 * 60 * 60 * 1000;
const retainedDataLimit = new DeliveryError('Board retained-data limit reached.');
type Retain = (projection: unknown) => void;
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DeliveryError('Board observation is incomplete.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || /\p{Cc}/u.test(value))
    throw new DeliveryError('Board identity is incomplete.');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new DeliveryError('Board number is incomplete.');
  return value;
}
function timestamp(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new DeliveryError('Board timestamp is incomplete.');
  return parsed;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new DeliveryError('Board connection is incomplete.');
  return value;
}
function code(error: unknown): string {
  if (error === retainedDataLimit) return 'retained-data-limit';
  const status: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : undefined;
  return status === 401 || status === 403 ? 'access-denied' : status === 404 ? 'not-readable' : 'read-incomplete';
}
export function parseDeliveryBoardRequest(raw: unknown): DeliveryBoardRequest {
  const input = record(raw),
    repos: string[] = [],
    decisionLabels: string[] = [];
  for (const value of array(input.repos)) {
    if (typeof value !== 'string' || !repositoryPattern.test(value))
      throw new DeliveryError('Board repos must contain explicit owner/name selectors.');
    const repository = value.toLowerCase();
    if (!repos.includes(repository)) repos.push(repository);
  }
  if (!repos.length) throw new DeliveryError('Board repos must not be empty.');
  const labels = new Set<string>();
  for (const value of input.decisionLabels === undefined ? [] : array(input.decisionLabels)) {
    if (typeof value !== 'string' || !value.trim() || /\p{Cc}/u.test(value))
      throw new DeliveryError('Board decision labels must be nonempty single-line strings.');
    if (!labels.has(value.trim().toLowerCase())) decisionLabels.push(value.trim());
    labels.add(value.trim().toLowerCase());
  }
  return { repos, decisionLabels };
}
function coverage(): BoardCoverage {
  return { status: 'complete', observed: 0, unknownRows: [], reasons: [] };
}
function metric(): BoardMetric {
  return { marked: 0, total: 0, unknown: 0, complete: true, percentage: null, reasons: [] };
}
function emptyRepository(repository: string): BoardRepository {
  return {
    repository,
    access: 'unknown',
    humanAttention: [],
    readyPrs: [],
    blockedPrs: [],
    staleIssues: [],
    coverage: {
      humanAttention: coverage(),
      readyPrs: coverage(),
      blockedPrs: coverage(),
      staleIssues: coverage(),
    },
    diagnostics: [],
    metrics: { opened: metric(), merged: metric() },
  };
}
function gap(
  result: BoardRepository,
  retain: Retain,
  section: BoardSection,
  reason: string,
  row?: BoardRow,
  unavailable = false,
): void {
  const at = result.coverage[section];
  if (unavailable || at.status === 'unavailable') at.status = 'unavailable';
  else at.status = 'partial';
  if (!at.reasons.includes(reason)) at.reasons.push(reason);
  if (row) {
    // Unknown rows retain identity and reason, never an unbounded rejected title.
    const bounded = {
      repository: row.repository,
      id: row.id,
      number: row.number,
      url: row.url,
      title: '',
      reasons: [reason],
    };
    try {
      retain(bounded);
      at.unknownRows.push(bounded);
    } catch (error) {
      if (error !== retainedDataLimit) throw error;
      if (!at.reasons.includes('unknown-rows-omitted')) at.reasons.push('unknown-rows-omitted');
    }
  }
}

function resultRow<T extends BoardRow>(
  result: BoardRepository,
  retain: Retain,
  section: BoardSection,
  row: T,
): T | null {
  try {
    retain(row);
    return row;
  } catch (error) {
    if (error !== retainedDataLimit) throw error;
    gap(result, retain, section, 'retained-data-limit');
    const bounded = { ...row, title: '' };
    try {
      retain(bounded);
      return bounded;
    } catch (fallbackError) {
      if (fallbackError !== retainedDataLimit) throw fallbackError;
      gap(result, retain, section, 'retained-data-limit', row);
      return null;
    }
  }
}
function row(repository: string, raw: unknown, kind: 'issues' | 'pull'): BoardRow {
  const value = record(raw),
    n = number(value.number),
    url = text(value.html_url);
  if (url.toLowerCase() !== `https://github.com/${repository}/${kind}/${n}`)
    throw new DeliveryError('Board row repository identity is inconsistent.');
  return {
    repository,
    id: text(value.node_id),
    number: n,
    url,
    title: typeof value.title === 'string' ? value.title : '',
    reasons: [],
  };
}

type NativeIssue = { row: BoardRow; labels: string[]; updatedAt: number };
async function issues(
  context: { clients: GitHubClients; repo: DeliveryContext['repo'] },
  result: BoardRepository,
  retain: Retain,
  signal?: AbortSignal,
): Promise<NativeIssue[]> {
  const found: NativeIssue[] = [],
    ids = new Set<string>();
  try {
    for (let page = 1; page <= pageLimit; page++) {
      signal?.throwIfAborted();
      const response = await context.clients.rest.issues.listForRepo({
        ...context.repo,
        state: 'open',
        per_page: 100,
        page,
      });
      signal?.throwIfAborted();
      for (const value of response.data) {
        if (value.pull_request !== undefined) continue;
        const item = row(result.repository, value, 'issues');
        if (value.state !== 'open' || ids.has(item.id)) throw new DeliveryError('Issue inventory identity changed.');
        const labels = value.labels.map((label) => (typeof label === 'string' ? label : text(label.name)));
        const updatedAt = timestamp(value.updated_at);
        const observation = { row: { ...item, updatedAt: value.updated_at }, labels, updatedAt };
        retain(observation);
        ids.add(item.id);
        found.push(observation);
      }
      if (response.data.length < 100 && !response.headers.link?.includes('rel="next"')) return found;
    }
    throw new DeliveryError('Issue inventory reached its page limit.');
  } catch (error) {
    signal?.throwIfAborted();
    gap(result, retain, 'humanAttention', code(error));
    gap(result, retain, 'staleIssues', code(error));
    return found;
  }
}

async function attention(
  context: { clients: GitHubClients; repo: DeliveryContext['repo'] },
  repositoryId: string,
  issue: NativeIssue,
  retain: Retain,
  signal?: AbortSignal,
): Promise<BoardAttentionRow['journal']> {
  let cursor: string | null = null,
    retained = 0;
  const cursors = new Set<string>(),
    ids = new Set<string>();
  let latest: { created: number; numeric: bigint; body: string; id: string; url: string } | null = null;
  for (let page = 0; page < pageLimit; page++) {
    signal?.throwIfAborted();
    const response: unknown = await context.clients.graphql(
      `query DeliveryBoardJournal($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) { id nameWithOwner issue(number: $number) { id number
        comments(last: 100, before: $cursor) { nodes { id fullDatabaseId createdAt url body } pageInfo { hasPreviousPage startCursor } }
      } }
    }`,
      { ...context.repo, number: issue.row.number, cursor },
    );
    signal?.throwIfAborted();
    const parent = record(record(response).repository),
      native = record(parent.issue),
      connection = record(native.comments);
    if (
      parent.id !== repositoryId ||
      text(parent.nameWithOwner).toLowerCase() !== issue.row.repository ||
      native.id !== issue.row.id ||
      native.number !== issue.row.number
    )
      throw new DeliveryError('Journal parent identity is inconsistent.');
    for (const raw of array(connection.nodes)) {
      const comment = record(raw),
        id = text(comment.id);
      if (ids.has(id)) throw new DeliveryError('Journal comment identity repeated.');
      ids.add(id);
      if (typeof comment.body !== 'string') throw new DeliveryError('Journal body is incomplete.');
      retained += Buffer.byteLength(JSON.stringify(comment));
      if (retained > retainedLimit) throw retainedDataLimit;
      retain(id);
      if (!/<!--\s*ai-delivery:journal@/u.test(comment.body)) continue;
      const created = timestamp(comment.createdAt),
        nativeId = comment.fullDatabaseId;
      if (
        (typeof nativeId !== 'string' || !/^[1-9]\d*$/u.test(nativeId)) &&
        (typeof nativeId !== 'number' || !Number.isSafeInteger(nativeId) || nativeId <= 0)
      )
        throw new DeliveryError('Journal numeric identity is incomplete.');
      const numeric = BigInt(nativeId as string | number),
        url = text(comment.url);
      if (latest && latest.created === created && latest.numeric === numeric)
        throw new DeliveryError('Journal ordering identity repeated.');
      if (!latest || created > latest.created || (created === latest.created && numeric > latest.numeric))
        latest = { created, numeric, body: comment.body, id, url };
    }
    const info = record(connection.pageInfo);
    if (info.hasPreviousPage === false) {
      const result = latest
        ? { ...parseJournalAttention(latest.body), commentId: latest.id, url: latest.url }
        : { kind: null, state: 'clear' as const, request: null, reason: null, commentId: null, url: null };
      retain(result);
      return result;
    }
    if (info.hasPreviousPage !== true) throw new DeliveryError('Journal pagination is incomplete.');
    cursor = text(info.startCursor);
    if (cursors.has(cursor)) throw new DeliveryError('Journal cursor repeated.');
    cursors.add(cursor);
  }
  throw new DeliveryError('Journal page limit reached.');
}

type ProjectRead = { identity: string; items: ProjectItemObservation[] | null };
async function projectItems(
  context: DeliveryContext,
  cache: Map<string, ProjectRead>,
  principal: string,
  retain: Retain,
  signal?: AbortSignal,
): Promise<ProjectItemObservation[]> {
  const routing = context.configuration?.routing;
  if (!routing) throw new DeliveryError('Project routing is unavailable.');
  const key = `${principal}:${routing.projectId}`;
  const expected = digestValue({
    projectId: routing.projectId,
    statusFieldId: routing.statusFieldId,
    statusOptionIds: routing.statusOptionIds,
    pointsFieldId: routing.pointsFieldId,
    priorityFieldId: routing.priorityFieldId,
    organization: context.config.native.organization,
    settings: projectSettingsFromDeliveryConfig(context.config),
  });
  const prior = cache.get(key);
  if (prior) {
    if (prior.identity !== expected || !prior.items)
      throw new DeliveryError('Shared Project mapping or inventory is incomplete.');
    return prior.items;
  }
  cache.set(key, { identity: expected, items: null });
  signal?.throwIfAborted();
  const configuration: ProjectDeliveryConfiguration = await getProjectDeliveryConfiguration({
    graphql: context.clients.graphql,
    org: context.config.native.organization,
    settings: projectSettingsFromDeliveryConfig(context.config),
    requireWritable: false,
    maxPages: pageLimit,
  });
  if (
    routing.projectId !== configuration.projectId ||
    routing.statusFieldId !== configuration.statusFieldId ||
    digestValue(routing.statusOptionIds) !== digestValue(configuration.statusOptionIds) ||
    routing.pointsFieldId !== configuration.pointsFieldId ||
    routing.priorityFieldId !== configuration.priorityFieldId
  )
    throw new DeliveryError('Project routing changed during collection.');
  signal?.throwIfAborted();
  const items = await readProjectDeliveryItems({
    graphql: context.clients.graphql,
    org: context.config.native.organization,
    configuration,
    maxPages: pageLimit,
  });
  signal?.throwIfAborted();
  retain(items);
  cache.set(key, { identity: expected, items });
  return items;
}

async function prs(
  context: { clients: GitHubClients; repo: DeliveryContext['repo'] },
  repositoryId: string,
  result: BoardRepository,
  retain: Retain,
  signal?: AbortSignal,
): Promise<void> {
  const ids = new Set<string>();
  try {
    for (let page = 1; page <= pageLimit; page++) {
      signal?.throwIfAborted();
      const response = await context.clients.rest.pulls.list({ ...context.repo, state: 'open', per_page: 100, page });
      signal?.throwIfAborted();
      for (const value of response.data) {
        const item = row(result.repository, value, 'pull');
        if (ids.has(item.id) || value.state !== 'open') throw new DeliveryError('PR inventory identity changed.');
        retain(item.id);
        ids.add(item.id);
        try {
          signal?.throwIfAborted();
          const facts = await readPrBoardFacts(context, item.number);
          signal?.throwIfAborted();
          if (facts.repository.id !== repositoryId) throw new DeliveryError('PR repository identity changed.');
          retain(facts);
          (facts.ready ? result.readyPrs : result.blockedPrs).push(facts);
          result.coverage.readyPrs.observed++;
          result.coverage.blockedPrs.observed++;
          if (
            !facts.stable ||
            !facts.review.observed ||
            !facts.closingLinks.complete ||
            facts.currentBaseSha !== facts.baseSha ||
            facts.mergeable === null ||
            facts.mergeable === 'UNKNOWN' ||
            facts.mergeStateStatus === null ||
            facts.mergeStateStatus === 'UNKNOWN' ||
            facts.reasons.includes('checks-unproven')
          ) {
            gap(result, retain, 'readyPrs', 'pr-evidence-unknown');
            gap(result, retain, 'blockedPrs', 'pr-evidence-unknown');
          }
        } catch (error) {
          signal?.throwIfAborted();
          gap(result, retain, 'readyPrs', code(error), item);
          gap(result, retain, 'blockedPrs', code(error), item);
        }
      }
      if (response.data.length < 100 && !response.headers.link?.includes('rel="next"')) return;
    }
    throw new DeliveryError('PR inventory page limit reached.');
  } catch (error) {
    signal?.throwIfAborted();
    gap(result, retain, 'readyPrs', code(error));
    gap(result, retain, 'blockedPrs', code(error));
  }
}

async function usage(
  context: { clients: GitHubClients; repo: DeliveryContext['repo'] },
  repositoryId: string,
  repository: string,
  kind: 'opened' | 'merged',
  asOf: number,
  retain: Retain,
  signal?: AbortSignal,
): Promise<BoardMetric> {
  const result = metric(),
    ids = new Set<string>(),
    cursors = new Set<string>();
  const from = asOf - 7 * day,
    qualifier = kind === 'opened' ? 'created' : 'merged';
  // Search only represents whole seconds. Enclose the exact window, then filter locally.
  const query = `repo:${repository} is:pr ${qualifier}:>=${new Date(Math.floor(from / 1000) * 1000).toISOString()} ${qualifier}:<${new Date(Math.ceil(asOf / 1000) * 1000).toISOString()}`;
  let cursor: string | null = null,
    retained = 0,
    count: number | null = null;
  try {
    for (let page = 0; page < pageLimit; page++) {
      signal?.throwIfAborted();
      const response: unknown = await context.clients.graphql(
        `query DeliveryBoardSearch($q: String!, $cursor: String) {
        search(query: $q, type: ISSUE, first: 100, after: $cursor) { issueCount nodes {
          __typename ... on PullRequest { id number url repository { id nameWithOwner } createdAt mergedAt body mergeCommit { oid message } }
        } pageInfo { hasNextPage endCursor } }
      }`,
        { q: query, cursor },
      );
      signal?.throwIfAborted();
      const search = record(record(response).search);
      if (
        typeof search.issueCount !== 'number' ||
        !Number.isSafeInteger(search.issueCount) ||
        search.issueCount < 0 ||
        search.issueCount > 1000
      )
        throw new DeliveryError('Search count is incomplete or exceeds the native ceiling.');
      if (count !== null && count !== search.issueCount) throw new DeliveryError('Search count changed.');
      count = search.issueCount;
      for (const raw of array(search.nodes)) {
        const pr = record(raw),
          parent = record(pr.repository);
        retained += Buffer.byteLength(JSON.stringify(pr));
        if (retained > retainedLimit) throw retainedDataLimit;
        const id = text(pr.id);
        if (
          pr.__typename !== 'PullRequest' ||
          parent.id !== repositoryId ||
          text(parent.nameWithOwner).toLowerCase() !== repository ||
          text(pr.url).toLowerCase() !== `https://github.com/${repository}/pull/${number(pr.number)}`
        )
          throw new DeliveryError('Search PR identity is incomplete.');
        if (ids.has(id)) {
          result.complete = false;
          if (!result.reasons.includes('duplicate-search-id')) result.reasons.push('duplicate-search-id');
          continue;
        }
        retain(id);
        ids.add(id);
        const event = timestamp(kind === 'opened' ? pr.createdAt : pr.mergedAt);
        if (event < from || event >= asOf) continue;
        result.total++;
        if (kind === 'opened') {
          if (typeof pr.body !== 'string') {
            result.unknown++;
            result.complete = false;
          } else if (hasDeliveryPrMarker(pr.body)) result.marked++;
        } else {
          const commit = pr.mergeCommit;
          if (
            typeof commit !== 'object' ||
            commit === null ||
            !/^[a-f0-9]{40}$/u.test(String(Reflect.get(commit, 'oid'))) ||
            typeof Reflect.get(commit, 'message') !== 'string'
          ) {
            result.unknown++;
            result.complete = false;
          } else if (hasDeliveryMergeTrailer(Reflect.get(commit, 'message') as string)) result.marked++;
        }
      }
      const info = record(search.pageInfo);
      if (info.hasNextPage === false) {
        if (ids.size !== count) {
          result.complete = false;
          result.reasons.push('search-count-mismatch');
        }
        if (result.unknown) result.reasons.push('marker-source-unknown');
        result.percentage = result.complete && result.total > 0 ? (100 * result.marked) / result.total : null;
        return result;
      }
      if (info.hasNextPage !== true) throw new DeliveryError('Search pagination is incomplete.');
      cursor = text(info.endCursor);
      if (cursors.has(cursor)) throw new DeliveryError('Search cursor repeated.');
      cursors.add(cursor);
    }
    throw new DeliveryError('Search page limit reached.');
  } catch (error) {
    signal?.throwIfAborted();
    result.complete = false;
    result.percentage = null;
    result.reasons.push(code(error));
    return result;
  }
}

/** Request-local native observations. This function never initializes or advances delivery state. */
export async function collectDeliveryBoard(
  raw: DeliveryBoardRequest,
  execution: ExecutionContext,
): Promise<DeliveryBoardResult> {
  const request = parseDeliveryBoardRequest(raw),
    signal = execution.signal;
  if (
    execution.repo !== undefined &&
    (request.repos.length !== 1 || request.repos[0] !== execution.repo.trim().toLowerCase())
  )
    throw new DeliveryError('Board and execution repo selectors disagree.');
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString(),
    asOf = Date.parse(startedAt);
  // Reserve result envelopes and bounded diagnostic metadata before any access.
  let retained = Buffer.byteLength(JSON.stringify(request.repos.map(emptyRepository))) + request.repos.length * 4096;
  if (retained > retainedLimit) throw new DeliveryError('Board selectors exceed the retained-data bound.');
  const retain: Retain = (projection) => {
    const bytes = Buffer.byteLength(JSON.stringify(projection)) + 4;
    if (retained + bytes > retainedLimit) throw retainedDataLimit;
    retained += bytes;
  };
  const settings = execution.settings ?? (await loadDeliverySettings());
  signal?.throwIfAborted();
  const identity = execution.identity ?? settings.roles.author.identity;
  const policy = evaluateCommandIdentityPolicy({
    commandName: 'board:reconcile',
    deliveryConfig: settings,
    identity,
    ...(execution.personalAuth === undefined ? {} : { personalAuth: execution.personalAuth }),
  });
  if (policy.error) throw new DeliveryError(policy.error);
  const clients = await createDeliveryGitHubClients({
    config: settings,
    identity,
    role: 'author',
    ...(settings.environment === undefined ? {} : { env: settings.environment }),
    ...(execution.personalAuth === true ? { personalAuth: { enabled: true as const } } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  const projects = new Map<string, ProjectRead>(),
    repositories: BoardRepository[] = [];
  // Conservatively charge collected projections, including shared inventory and
  // retained identity sets, across all repositories. This is not an HTTP/RSS cap.
  let principal: string | null = null;
  try {
    principal = await principalIdentity(clients, signal);
  } catch {
    signal?.throwIfAborted();
  }
  for (const repository of request.repos) {
    signal?.throwIfAborted();
    const result = emptyRepository(repository);
    repositories.push(result);
    const [owner, name] = repository.split('/'),
      readContext = { clients, repo: { owner: owner!, repo: name! } };
    let repositoryId: string;
    try {
      const native = (await clients.rest.repos.get(readContext.repo)).data;
      signal?.throwIfAborted();
      repositoryId = text(native.node_id);
      if (text(native.full_name).toLowerCase() !== repository) throw new DeliveryError('Repository identity changed.');
      result.access = 'readable';
    } catch (error) {
      signal?.throwIfAborted();
      result.access = 'unreadable';
      for (const section of Object.keys(result.coverage) as BoardSection[])
        gap(result, retain, section, code(error), undefined, true);
      for (const at of Object.values(result.metrics)) {
        at.complete = false;
        at.reasons.push(code(error));
      }
      result.diagnostics.push({ scope: 'repository', code: code(error) });
      continue;
    }
    const nativeIssues = await issues(readContext, result, retain, signal);
    for (const issue of nativeIssues) {
      signal?.throwIfAborted();
      const labels = issue.labels.filter((label) =>
        request.decisionLabels.some((selected) => selected.toLowerCase() === label.toLowerCase()),
      );
      let journal: BoardAttentionRow['journal'];
      try {
        journal = await attention(readContext, repositoryId, issue, retain, signal);
        if (journal.state === 'unknown') gap(result, retain, 'humanAttention', 'journal-ambiguous', issue.row);
      } catch (error) {
        signal?.throwIfAborted();
        journal = { kind: null, state: 'unknown', request: null, reason: code(error), commentId: null, url: null };
        gap(result, retain, 'humanAttention', code(error), issue.row);
      }
      result.coverage.humanAttention.observed++;
      if (labels.length || journal.state === 'pending') {
        const item = resultRow(result, retain, 'humanAttention', {
          ...issue.row,
          labels,
          journal,
          request: journal.request,
          reasons: [
            ...(labels.length ? ['decision-label'] : []),
            ...(journal.state === 'pending' ? ['journal-request'] : []),
          ],
        });
        if (item) result.humanAttention.push(item);
      }
    }
    await prs(readContext, repositoryId, result, retain, signal);
    let context: DeliveryContext | null = null;
    try {
      signal?.throwIfAborted();
      const candidate = await loadDeliveryContext({
        settings,
        identity,
        role: 'author',
        repoRoot: execution.repoRoot,
        repository,
        readPageLimit: pageLimit,
        requireWritableProject: false,
        ...(settings.environment === undefined ? {} : { env: settings.environment }),
        ...(execution.personalAuth === undefined ? {} : { personalAuth: execution.personalAuth }),
        ...(signal === undefined ? {} : { signal }),
      });
      signal?.throwIfAborted();
      if (
        candidate.config.repository.toLowerCase() !== repository ||
        `${candidate.repo.owner}/${candidate.repo.repo}`.toLowerCase() !== repository ||
        candidate.clients.role !== 'author' ||
        candidate.configuration?.routing.repositoryId !== repositoryId ||
        principal === null ||
        (await principalIdentity(candidate.clients, signal)) !== principal
      )
        throw new DeliveryError('Configured context identity changed.');
      context = candidate;
      const items = await projectItems(context, projects, principal, retain, signal);
      const index = new Map<string, ProjectItemObservation[]>();
      for (const item of items) {
        if (item.archived || item.contentKind !== 'issue' || item.repository?.toLowerCase() !== repository) continue;
        const key = `${item.contentId}:${item.issueNumber}`;
        index.set(key, [...(index.get(key) ?? []), item]);
      }
      for (const issue of nativeIssues) {
        const matches = index.get(`${issue.row.id}:${issue.row.number}`),
          item = matches?.[0];
        if (matches?.length !== 1 || !item || item.statusRead !== 'verified' || item.status === null)
          gap(result, retain, 'staleIssues', 'project-status-unknown', issue.row);
        else {
          result.coverage.staleIssues.observed++;
          if (item.status === 'In Progress' && issue.updatedAt <= asOf - 3 * day) {
            const stale = resultRow(result, retain, 'staleIssues', {
              ...issue.row,
              state: item.status,
              reasons: ['stale-72h'],
            });
            if (stale) result.staleIssues.push(stale);
          }
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      gap(result, retain, 'staleIssues', code(error), undefined, true);
      for (const issue of nativeIssues) gap(result, retain, 'staleIssues', code(error), issue.row, true);
      result.diagnostics.push({ scope: 'project', code: code(error) });
    }
    result.metrics.opened = await usage(readContext, repositoryId, repository, 'opened', asOf, retain, signal);
    result.metrics.merged = await usage(readContext, repositoryId, repository, 'merged', asOf, retain, signal);
    for (const rows of [result.humanAttention, result.readyPrs, result.blockedPrs, result.staleIssues])
      rows.sort((a, b) => a.number - b.number);
  }
  signal?.throwIfAborted();
  return {
    schemaVersion: 'ai-delivery.board@1',
    collection: { startedAt, completedAt: new Date().toISOString(), asOf: startedAt },
    complete: repositories.every(
      (result) =>
        result.access === 'readable' &&
        Object.values(result.coverage).every((at) => at.status === 'complete') &&
        Object.values(result.metrics).every((at) => at.complete),
    ),
    repositories,
  };
}

async function principalIdentity(clients: GitHubClients, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (clients.role !== 'author' || !clients.authenticatedAuthor)
    throw new DeliveryError('Selected author identity is unavailable.');
  const actor = await clients.authenticatedAuthor(signal);
  signal?.throwIfAborted();
  return digestValue({ actor: text(actor.actorLogin).toLowerCase(), credential: text(actor.credentialIdentity) });
}
