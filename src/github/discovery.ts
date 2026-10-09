import type { graphql as GraphQLType } from '@octokit/graphql';

import type { DeliveryConfig, DeliveryOverrides } from '../config/deliveryConfig.js';
import { DeliveryError } from '../errors.js';
import {
  readProjectDeliveryDefinition,
  resolveProjectDeliveryConfiguration,
  type ProjectDeliveryConfiguration,
} from './projectDelivery.js';

export interface DiscoveryClients {
  graphql: typeof GraphQLType;
}
export interface DeliveryRouting {
  repository: string;
  repositoryId: string;
  projectId: string;
  projectSource: 'explicit' | 'linked';
  statusFieldId: string;
  statusOptionIds: ProjectDeliveryConfiguration['statusOptionIds'];
  pointsFieldId: string;
  priorityFieldId: string;
  native: DeliveryConfig['native'];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DeliveryError(`Incomplete GitHub ${label} discovery.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DeliveryError(`Invalid GitHub ${label}.`);
  return value;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new DeliveryError(`Invalid GitHub ${label}.`);
  return value;
}
function responseRepository(value: unknown): Record<string, unknown> {
  const result = record(value, 'repository');
  if ('errors' in result) throw new DeliveryError('Partial GitHub discovery cannot select a delivery destination.');
  return record(result.repository, 'repository');
}

/** Never turn a failed page, hidden/null node or nonadvancing cursor into a unique candidate. */
async function repositoryConnection(input: {
  clients: DiscoveryClients;
  owner: string;
  repo: string;
  field: 'issueTypes' | 'issueFields' | 'projectsV2';
  selection: string;
}): Promise<Record<string, unknown>[]> {
  const nodes: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const result: unknown = await input.clients.graphql(
      `query DeliveryDiscovery($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        ${input.field}(first: 100, after: $cursor) { nodes { ${input.selection} } pageInfo { hasNextPage endCursor } }
      }
    }`,
      { owner: input.owner, repo: input.repo, cursor },
    );
    const connection = record(responseRepository(result)[input.field], input.field);
    if (!Array.isArray(connection.nodes)) throw new DeliveryError(`Incomplete GitHub ${input.field} nodes.`);
    for (const value of connection.nodes) {
      const node = record(value, input.field);
      const id = text(node.id, `${input.field} node ID`);
      if (ids.has(id)) throw new DeliveryError(`Repeated ${input.field} node during discovery.`);
      ids.add(id);
      nodes.push(node);
    }
    const page = record(connection.pageInfo, `${input.field} pagination`);
    if (typeof page.hasNextPage !== 'boolean') throw new DeliveryError('Incomplete GitHub discovery pagination.');
    if (!page.hasNextPage) return nodes;
    const next = text(page.endCursor, 'discovery cursor');
    if (next === cursor || cursors.has(next)) throw new DeliveryError('GitHub discovery cursor did not advance.');
    cursors.add(next);
    cursor = next;
  }
}

function nativeField(nodes: Record<string, unknown>[], name: string): DeliveryConfig['native']['points'] {
  const matches = nodes.filter((node) => node.name === name);
  if (matches.length !== 1) throw new DeliveryError(`Select an unambiguous native single-select field for ${name}.`);
  const field = matches[0];
  if (!field || field.__typename !== 'IssueFieldSingleSelect' || !Array.isArray(field.options)) {
    throw new DeliveryError(`Native ${name} must be an organization single-select issue field.`);
  }
  const databaseId = String(field.fullDatabaseId);
  if (!/^[1-9]\d*$/u.test(databaseId) || !Number.isSafeInteger(Number(databaseId))) {
    throw new DeliveryError(`Invalid native ${name} field ID.`);
  }
  const values = field.options.map((value) => text(record(value, `${name} option`).name, `${name} option name`)).sort();
  if (!values.length || new Set(values).size !== values.length)
    throw new DeliveryError(`Ambiguous native ${name} options.`);
  return { databaseId, name, values };
}

export async function discoverDeliveryRouting(input: {
  clients: DiscoveryClients;
  repository: string;
  overrides: DeliveryOverrides;
  repositorySelected?: boolean;
}): Promise<DeliveryRouting> {
  const [owner, repo] = input.repository.split('/');
  if (!owner || !repo) throw new DeliveryError('Invalid delivery repository.');
  const identity = responseRepository(
    await input.clients.graphql(
      `query DeliveryRepository($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) { id nameWithOwner isFork owner { __typename login } }
  }`,
      { owner, repo },
    ),
  );
  const repository = text(identity.nameWithOwner, 'repository name');
  if (repository.toLowerCase() !== input.repository.toLowerCase())
    throw new DeliveryError('GitHub repository does not match the selected Git remote.');
  if (typeof identity.isFork !== 'boolean') throw new DeliveryError('GitHub omitted repository fork identity.');
  if (identity.isFork && input.overrides.remote === undefined && input.repositorySelected !== true)
    throw new DeliveryError('A fork requires an explicit remote selection before delivery.');
  const org = record(identity.owner, 'repository owner');
  if (org.__typename !== 'Organization' || text(org.login, 'organization').toLowerCase() !== owner.toLowerCase()) {
    throw new DeliveryError('Native delivery requires a repository owned by its selected GitHub organization.');
  }
  const fields = await repositoryConnection({
    ...input,
    owner,
    repo,
    field: 'issueFields',
    selection: `__typename
    ... on IssueFieldSingleSelect { id fullDatabaseId name options { id name } }
    ... on IssueFieldDate { id }
    ... on IssueFieldNumber { id }
    ... on IssueFieldText { id }
  `,
  });
  const points = nativeField(fields, input.overrides.pointsField ?? 'Points');
  const priority = nativeField(fields, input.overrides.priorityField ?? 'Priority');
  const types = await repositoryConnection({
    ...input,
    owner,
    repo,
    field: 'issueTypes',
    selection: 'id name isEnabled',
  });
  const availableTypes = types
    .filter((type) => {
      if (typeof type.isEnabled !== 'boolean') throw new DeliveryError('GitHub omitted issue type availability.');
      return type.isEnabled;
    })
    .map((type) => text(type.name, 'issue type'))
    .sort();
  if (!availableTypes.length || new Set(availableTypes).size !== availableTypes.length)
    throw new DeliveryError('No unambiguous enabled native issue types were discovered.');
  const issueTypes = input.overrides.issueTypes?.slice().sort() ?? availableTypes;
  if (issueTypes.some((type) => !availableTypes.includes(type)))
    throw new DeliveryError('Configured issue type is unavailable in the selected repository.');
  const projectSource = input.overrides.project === undefined ? 'linked' : 'explicit';
  const candidates =
    input.overrides.project === undefined
      ? await repositoryConnection({
          ...input,
          owner,
          repo,
          field: 'projectsV2',
          selection:
            'id number title closed viewerCanUpdate owner { __typename ... on Organization { login } ... on User { login } }',
        })
      : [{ number: input.overrides.project }];
  const compatible: ProjectDeliveryConfiguration[] = [];
  for (const candidate of candidates) {
    if (projectSource === 'linked') {
      if (typeof candidate.closed !== 'boolean' || typeof candidate.viewerCanUpdate !== 'boolean')
        throw new DeliveryError('Incomplete linked Project metadata.');
      const projectOwner = record(candidate.owner, 'Project owner');
      if (
        projectOwner.__typename !== 'Organization' ||
        text(projectOwner.login, 'Project owner').toLowerCase() !== owner.toLowerCase()
      ) {
        throw new DeliveryError('Linked Project owner does not match the selected repository organization.');
      }
      if (candidate.closed) continue;
    }
    const number = positive(candidate.number, 'Project number');
    // API/permission/partial-read failures propagate; only complete incompatible schemas are excluded.
    const project = await readProjectDeliveryDefinition({ graphql: input.clients.graphql, org: owner, number });
    if (typeof project.viewerCanUpdate !== 'boolean' || project.number !== number)
      throw new DeliveryError('Incomplete or drifting Project identity.');
    if (typeof project.closed !== 'boolean') throw new DeliveryError('GitHub omitted Project closed state.');
    if (project.closed) {
      if (projectSource === 'explicit') throw new DeliveryError('The explicitly selected Project is closed.');
      continue;
    }
    if (projectSource === 'linked' && (project.id !== candidate.id || project.title !== candidate.title))
      throw new DeliveryError('Linked Project changed during discovery.');
    const settings = {
      number,
      title: text(project.title, 'Project title'),
      points,
      priority,
      statusField: input.overrides.statusField ?? 'Status',
      statuses: {
        Todo: input.overrides.statuses?.todo ?? 'Todo',
        'In Progress': input.overrides.statuses?.inProgress ?? 'In Progress',
        Blocked: input.overrides.statuses?.blocked ?? 'Blocked',
        Done: input.overrides.statuses?.done ?? 'Done',
      },
    };
    let configuration: ProjectDeliveryConfiguration;
    try {
      configuration = resolveProjectDeliveryConfiguration(project, { settings, requireWritable: false });
    } catch (error) {
      if (projectSource === 'explicit' || !(error instanceof DeliveryError)) throw error;
      continue;
    }
    if (!configuration.writable)
      throw new DeliveryError('A compatible delivery Project is not writable; refusing destination fallback.');
    compatible.push(configuration);
  }
  if (compatible.length !== 1)
    throw new DeliveryError(
      `Discovered ${compatible.length} compatible linked Projects. Select project explicitly in ai-delivery.config.json; no issue was created.`,
    );
  const selected = compatible[0];
  if (!selected) throw new DeliveryError('Delivery Project selection is incomplete.');
  return {
    repository,
    repositoryId: text(identity.id, 'repository ID'),
    projectId: selected.projectId,
    projectSource,
    statusFieldId: selected.statusFieldId,
    statusOptionIds: selected.statusOptionIds,
    pointsFieldId: selected.pointsFieldId,
    priorityFieldId: selected.priorityFieldId,
    native: {
      organization: text(org.login, 'organization'),
      issueTypes,
      points,
      priority,
      milestones: 'repository',
      relationships: { blockedBy: 'native', parent: 'native' },
      project: {
        number: selected.projectNumber,
        title: selected.title,
        statusField: selected.settings.statusField,
        statuses: {
          todo: selected.settings.statuses.Todo,
          inProgress: selected.settings.statuses['In Progress'],
          blocked: selected.settings.statuses.Blocked,
          done: selected.settings.statuses.Done,
        },
      },
    },
  };
}
