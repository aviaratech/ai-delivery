import type { graphql as GraphQLType } from '@octokit/graphql';
import type { DeliveryConfig } from '../config/deliveryConfig.js';

import { CollectionLimitError, DeliveryError } from '../errors.js';

export const PROJECT_DELIVERY_STATUSES = ['Todo', 'In Progress', 'Blocked', 'Done'] as const;

export interface ProjectDeliverySettings {
  number: number;
  points: { databaseId: string; name: string; values: readonly string[] };
  priority: { databaseId: string; name: string; values: readonly string[] };
  statuses: Record<ProjectDeliveryStatus, string>;
  statusField: string;
  title: string;
}

export type ProjectDeliveryStatus = (typeof PROJECT_DELIVERY_STATUSES)[number];

export interface ProjectDeliveryArchiveReadback {
  archived: true;
  itemId: string;
}

export interface ProjectDeliveryConfiguration {
  pointsFieldId: string;
  priorityFieldId: string;
  projectId: string;
  projectNumber: number;
  settings: ProjectDeliverySettings;
  statusFieldId: string;
  statusOptionIds: Record<ProjectDeliveryStatus, string>;
  title: string;
  writable: boolean;
}

export interface ProjectDeliveryRestoreReadback {
  archived: false;
  itemId: string;
}

export interface ProjectDeliveryStatusReadback {
  itemId: string;
  status: ProjectDeliveryStatus;
}

interface ProjectDeliveryInput {
  /** Capacity guards require a known status and exact Project identity when an item exists. */
  capacityRead?: boolean;
  /** Optional finite item-read budget for bounded reports; existing callers retain their behavior. */
  maxPages?: number;
  configuration?: ProjectDeliveryConfiguration;
  graphql: typeof GraphQLType;
  issueNodeId: string;
  org: string;
  settings?: ProjectDeliverySettings;
}

interface ProjectDeliveryItem {
  archived: boolean;
  contentId: string;
  id: string;
  status: null | ProjectDeliveryStatus;
  statusOptionId: null | string;
}

export async function archiveIssueProjectItem(
  input: ProjectDeliveryInput,
): Promise<null | ProjectDeliveryArchiveReadback> {
  const configuration =
    input.configuration ??
    (await getProjectDeliveryConfiguration({
      ...input,
      settings: requireProjectSettings(input.settings),
      requireWritable: true,
    }));
  assertWritableConfiguration(configuration);
  const item = await findIssueProjectItem({ ...input, configuration });
  if (item === null) return null;
  if (item.archived) return { archived: true, itemId: item.id };

  const response: unknown = await input.graphql(
    `
      mutation ArchiveProjectDeliveryItem($projectId: ID!, $itemId: ID!) {
        archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
          item { id isArchived }
        }
      }
    `,
    { itemId: item.id, projectId: configuration.projectId },
  );
  const record = requireRecord(response, 'GitHub returned invalid Project archive evidence.');
  const payload = requireRecord(record.archiveProjectV2Item, 'GitHub omitted Project archive payload.');
  const archivedItem = requireRecord(payload.item, 'GitHub omitted the archived Project item.');
  if (archivedItem.id !== item.id || archivedItem.isArchived !== true) {
    throw new DeliveryError('Project archive mutation did not return the exact archived item.');
  }
  await readBackProjectArchiveState({
    archived: true,
    configuration,
    graphql: input.graphql,
    issueNodeId: input.issueNodeId,
    itemId: item.id,
  });
  return { archived: true, itemId: item.id };
}

export async function getIssueProjectStatus(
  input: ProjectDeliveryInput,
): Promise<null | ProjectDeliveryStatusReadback> {
  const configuration =
    input.configuration ??
    (await getProjectDeliveryConfiguration({ ...input, settings: requireProjectSettings(input.settings) }));
  let item = await findIssueProjectItem({ ...input, configuration });
  if (item === null || item.archived) return null;
  // The list projection may omit a status already verified by a direct item read.
  // Resolve that exact item without inferring a status or accepting a missing item.
  if (item.status === null && item.statusOptionId === null) {
    item = await readProjectItem({
      configuration,
      graphql: input.graphql,
      issueNodeId: input.issueNodeId,
      itemId: item.id,
      ...(input.capacityRead ? { capacityRead: true } : {}),
    });
  }
  if (item.archived) return null;
  if (item.status === null && item.statusOptionId === null) return null;
  const status = requireItemStatus(item, configuration);
  return { itemId: item.id, status };
}

export async function getProjectDeliveryConfiguration(input: {
  graphql: typeof GraphQLType;
  org: string;
  requireWritable?: boolean;
  settings: ProjectDeliverySettings;
  maxPages?: number;
}): Promise<ProjectDeliveryConfiguration> {
  const settings = requireProjectSettings(input.settings);
  const project = await readProjectDeliveryDefinition({
    graphql: input.graphql,
    org: input.org,
    number: settings.number,
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
  });
  return resolveProjectDeliveryConfiguration(project, { requireWritable: input.requireWritable === true, settings });
}

export async function readProjectDeliveryDefinition(input: {
  graphql: typeof GraphQLType;
  org: string;
  number: number;
  maxPages?: number;
}): Promise<Record<string, unknown>> {
  const nodes: unknown[] = [];
  let cursor: null | string = null;
  let hasNextPage = true;
  const seenCursors = new Set<string>();
  const fieldIds = new Set<string>();
  let project: null | Record<string, unknown> = null;
  let pages = 0;

  while (hasNextPage) {
    if (input.maxPages !== undefined && pages >= input.maxPages)
      throw new CollectionLimitError({
        collection: 'project-fields',
        pagesRequested: pages,
        rowsObserved: nodes.length,
        limit: input.maxPages,
      });
    pages++;
    const response: unknown = await input.graphql(
      `
        query ProjectDeliveryConfiguration($org: String!, $number: Int!, $cursor: String) {
          organization(login: $org) {
            projectV2(number: $number) {
              id
              number
              title
              closed
              viewerCanUpdate
              fields(first: 100, after: $cursor) {
                nodes {
                  __typename
                  ... on ProjectV2Field {
                    id
                    name
                    dataType
                  }
                  ... on ProjectV2IterationField {
                    id
                    name
                  }
                  ... on ProjectV2MultiSelectField {
                    id
                    name
                  }
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    isIssueField
                    options { id name }
                    issueField {
                      __typename
                      ... on IssueFieldSingleSelect {
                        id
                        fullDatabaseId
                        name
                        options { id name }
                      }
                    }
                  }
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }
      `,
      { cursor, number: input.number, org: input.org },
    );
    const responseRecord = requireRecord(response, 'GitHub returned invalid delivery Project configuration.');
    if ('errors' in responseRecord) throw new DeliveryError('GitHub returned partial delivery Project evidence.');
    const organization = requireRecord(
      responseRecord.organization,
      `Organization ${input.org} is unavailable to the selected GitHub identity.`,
    );
    const pageProject = requireRecord(
      organization.projectV2,
      `Expected organization Project #${String(input.number)}.`,
    );
    const fields = requireRecord(pageProject.fields, 'GitHub omitted delivery Project fields.');
    const previousProject = project;
    if (
      previousProject !== null &&
      ['id', 'number', 'title', 'closed', 'viewerCanUpdate'].some((key) => previousProject[key] !== pageProject[key])
    ) {
      throw new DeliveryError('Delivery Project identity changed while reading its field pages.');
    }
    if (!Array.isArray(fields.nodes)) {
      throw new DeliveryError('GitHub returned invalid delivery Project field nodes.');
    }
    for (const node of fields.nodes) {
      const field = requireRecord(node, 'GitHub returned an incomplete delivery Project field.');
      const fieldId = requireString(field.id, 'GitHub omitted a delivery Project field ID.');
      if (fieldIds.has(fieldId)) throw new DeliveryError('GitHub repeated a delivery Project field.');
      fieldIds.add(fieldId);
      requireString(field.name, 'GitHub omitted a delivery Project field name.');
      requireString(field.__typename, 'GitHub omitted a delivery Project field type.');
      if (field.__typename === 'ProjectV2SingleSelectField') {
        if (typeof field.isIssueField !== 'boolean')
          throw new DeliveryError('GitHub omitted the Project field binding kind.');
        readOptions(field.options, 'Project field');
        if (field.isIssueField) {
          const issueField = requireRecord(field.issueField, 'GitHub omitted the bound organization field.');
          requireString(issueField.__typename, 'GitHub omitted the bound organization field type.');
          if (issueField.__typename === 'IssueFieldSingleSelect') {
            requireString(issueField.id, 'GitHub omitted the bound organization field ID.');
            requireString(issueField.name, 'GitHub omitted the bound organization field name.');
            if (!/^[1-9]\d*$/u.test(String(issueField.fullDatabaseId)))
              throw new DeliveryError('GitHub omitted the bound organization field database ID.');
            readOptions(issueField.options, 'organization field');
          }
        }
      }
      nodes.push(node as unknown);
    }
    project = { ...pageProject, fields: { nodes } };
    const pageInfo = requireRecord(fields.pageInfo, 'GitHub omitted delivery Project field pagination.');
    if (typeof pageInfo.hasNextPage !== 'boolean')
      throw new DeliveryError('GitHub omitted delivery Project pagination state.');
    hasNextPage = pageInfo.hasNextPage === true;
    const nextCursor = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
    assertAdvancingCursor({ cursor, hasNextPage, nextCursor, seenCursors, surface: 'field' });
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (project === null) {
    throw new DeliveryError(`Expected organization Project #${String(input.number)}.`);
  }
  return project;
}

export function projectSettingsFromDeliveryConfig(config: Pick<DeliveryConfig, 'native'>): ProjectDeliverySettings {
  const project = config.native.project;
  return {
    number: project.number,
    points: config.native.points,
    priority: config.native.priority,
    statuses: {
      Blocked: project.statuses.blocked,
      Done: project.statuses.done,
      'In Progress': project.statuses.inProgress,
      Todo: project.statuses.todo,
    },
    statusField: project.statusField,
    title: project.title,
  };
}

export function resolveProjectDeliveryConfiguration(
  raw: unknown,
  options: { requireWritable?: boolean; settings: ProjectDeliverySettings },
): ProjectDeliveryConfiguration {
  const settings = requireProjectSettings(options.settings);
  const project = requireRecord(raw, 'GitHub returned invalid delivery Project configuration.');
  if (project.number !== settings.number || project.title !== settings.title) {
    throw new DeliveryError(`Expected organization Project #${String(settings.number)} titled ${settings.title}.`);
  }
  if (options.requireWritable === true && project.viewerCanUpdate !== true) {
    throw new DeliveryError(`Organization Project #${String(settings.number)} is not writable by this identity.`);
  }
  const projectId = requireString(project.id, 'GitHub omitted the delivery Project node id.');
  const fields = requireRecord(project.fields, 'GitHub omitted delivery Project fields.');
  if (!Array.isArray(fields.nodes)) {
    throw new DeliveryError('GitHub returned invalid delivery Project field nodes.');
  }

  const statusField = requireExactlyOneField(fields.nodes, settings.statusField);
  const pointsField = requireBoundIssueField({
    expectedDatabaseId: settings.points.databaseId,
    expectedOptions: settings.points.values,
    fields: fields.nodes,
    name: settings.points.name,
  });
  const priorityField = requireBoundIssueField({
    expectedDatabaseId: settings.priority.databaseId,
    expectedOptions: settings.priority.values,
    fields: fields.nodes,
    name: settings.priority.name,
  });

  if (statusField.__typename !== 'ProjectV2SingleSelectField' || statusField.isIssueField !== false) {
    throw new DeliveryError('Project Status must be the sole Project-owned single-select workflow field.');
  }
  const statusOptions = readOptions(statusField.options, `Project ${settings.statusField}`);
  assertExactOptionSet({
    expected: PROJECT_DELIVERY_STATUSES.map((status) => settings.statuses[status]),
    fieldName: `Project ${settings.statusField}`,
    options: statusOptions,
  });
  const statusOptionIds = Object.fromEntries(
    PROJECT_DELIVERY_STATUSES.map((status) => [
      status,
      statusOptions.find((option) => option.name === settings.statuses[status])?.id,
    ]),
  ) as Record<ProjectDeliveryStatus, string>;

  return {
    pointsFieldId: requireString(pointsField.id, 'GitHub omitted the Project Points field id.'),
    priorityFieldId: requireString(priorityField.id, 'GitHub omitted the Project Priority field id.'),
    projectId,
    projectNumber: settings.number,
    settings,
    statusFieldId: requireString(statusField.id, 'GitHub omitted the Project Status field id.'),
    statusOptionIds,
    title: settings.title,
    writable: project.viewerCanUpdate === true,
  };
}

export async function restoreIssueProjectItem(
  input: ProjectDeliveryInput,
): Promise<null | ProjectDeliveryRestoreReadback> {
  const configuration =
    input.configuration ??
    (await getProjectDeliveryConfiguration({
      ...input,
      settings: requireProjectSettings(input.settings),
      requireWritable: true,
    }));
  assertWritableConfiguration(configuration);
  const item = await findIssueProjectItem({ ...input, configuration });
  if (item === null) return null;
  if (!item.archived) return { archived: false, itemId: item.id };

  const response: unknown = await input.graphql(
    `
      mutation RestoreProjectDeliveryItem($projectId: ID!, $itemId: ID!) {
        unarchiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
          item { id isArchived }
        }
      }
    `,
    { itemId: item.id, projectId: configuration.projectId },
  );
  const record = requireRecord(response, 'GitHub returned invalid Project restore evidence.');
  const payload = requireRecord(record.unarchiveProjectV2Item, 'GitHub omitted Project restore payload.');
  const restoredItem = requireRecord(payload.item, 'GitHub omitted the restored Project item.');
  if (restoredItem.id !== item.id || restoredItem.isArchived !== false) {
    throw new DeliveryError('Project restore mutation did not return the exact active item.');
  }
  await readBackProjectArchiveState({
    archived: false,
    configuration,
    graphql: input.graphql,
    issueNodeId: input.issueNodeId,
    itemId: item.id,
  });
  return { archived: false, itemId: item.id };
}

/** Read-only preflight; the later synchronization still checks for archive races. */
export async function assertIssueProjectWritable(input: ProjectDeliveryInput): Promise<void> {
  const configuration =
    input.configuration ??
    (await getProjectDeliveryConfiguration({
      ...input,
      settings: requireProjectSettings(input.settings),
      requireWritable: true,
    }));
  assertWritableConfiguration(configuration);
  const item = await findIssueProjectItem({ ...input, configuration });
  if (item?.archived === true)
    throw new DeliveryError('The issue delivery Project item is archived and cannot be updated.');
}

/** Add only membership and verify the exact unarchived item; Status is never written here. */
export async function ensureIssueProjectMembership(
  input: ProjectDeliveryInput & { beforeAdd?: () => Promise<void>; onItemKnown?: (itemId: string) => void },
): Promise<{ itemId: string; archived: false }> {
  const configuration =
    input.configuration ??
    (await getProjectDeliveryConfiguration({
      ...input,
      settings: requireProjectSettings(input.settings),
      requireWritable: true,
    }));
  assertWritableConfiguration(configuration);
  const existing = await findIssueProjectItem({ ...input, configuration, refuseUnreadable: true });
  if (existing?.archived) throw new DeliveryError('The issue delivery Project item is archived and cannot be updated.');
  let itemId = existing?.id;
  if (itemId === undefined) {
    await input.beforeAdd?.();
    const response: unknown = await input.graphql(
      `
        mutation AddProjectDeliveryItem($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
            item { id }
          }
        }
      `,
      { contentId: input.issueNodeId, projectId: configuration.projectId },
    );
    const added = requireRecord(response, 'GitHub returned invalid Project item creation evidence.');
    const payload = requireRecord(added.addProjectV2ItemById, 'GitHub omitted Project item creation payload.');
    const created = requireRecord(payload.item, 'GitHub omitted the created Project item.');
    itemId = requireString(created.id, 'GitHub omitted the created Project item id.');
  }
  // Retain mutation identity even if the exact readback is subsequently unavailable.
  input.onItemKnown?.(itemId);
  const item = await readProjectItem({ configuration, graphql: input.graphql, issueNodeId: input.issueNodeId, itemId });
  if (item.archived) throw new DeliveryError('Project membership readback is archived.');
  return { itemId, archived: false };
}

export async function syncIssueProjectStatus(
  input: ProjectDeliveryInput & {
    status: ProjectDeliveryStatus;
    beforeAdd?: () => Promise<void>;
    beforeAdvance?: () => Promise<void>;
  },
): Promise<ProjectDeliveryStatusReadback> {
  const configuration =
    input.configuration ??
    (await getProjectDeliveryConfiguration({
      ...input,
      settings: requireProjectSettings(input.settings),
      requireWritable: true,
    }));
  assertWritableConfiguration(configuration);
  let item = await findIssueProjectItem({ ...input, configuration });
  if (item?.archived === true) {
    throw new DeliveryError('The issue delivery Project item is archived and cannot be updated.');
  }
  if (
    item !== null &&
    item.status !== null &&
    item.statusOptionId !== null &&
    requireItemStatus(item, configuration) === input.status
  ) {
    return { itemId: item.id, status: input.status };
  }

  if (item === null) {
    const membership = await ensureIssueProjectMembership({ ...input, configuration });
    item = { archived: false, contentId: input.issueNodeId, id: membership.itemId, status: null, statusOptionId: null };
  }

  const optionId = configuration.statusOptionIds[input.status];
  await input.beforeAdvance?.();
  const updateResponse: unknown = await input.graphql(
    `
      mutation UpdateProjectDeliveryStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item { id }
        }
      }
    `,
    {
      fieldId: configuration.statusFieldId,
      itemId: item.id,
      optionId,
      projectId: configuration.projectId,
    },
  );
  const update = requireRecord(updateResponse, 'GitHub returned invalid Project Status mutation evidence.');
  const updatePayload = requireRecord(
    update.updateProjectV2ItemFieldValue,
    'GitHub omitted Project Status mutation payload.',
  );
  const updatedItem = requireRecord(updatePayload.projectV2Item, 'GitHub omitted the updated Project item.');
  if (updatedItem.id !== item.id) {
    throw new DeliveryError('Project Status mutation returned a different item identity.');
  }
  return await readBackProjectItem({
    configuration,
    graphql: input.graphql,
    issueNodeId: input.issueNodeId,
    itemId: item.id,
    status: input.status,
  });
}

function assertAdvancingCursor(input: {
  cursor: null | string;
  hasNextPage: boolean;
  nextCursor: null | string;
  seenCursors: ReadonlySet<string>;
  surface: string;
}): void {
  if (input.hasNextPage && input.nextCursor === null) {
    throw new DeliveryError(`Delivery Project ${input.surface} pagination omitted its next cursor.`);
  }
  if (
    input.hasNextPage &&
    input.nextCursor !== null &&
    (input.nextCursor === input.cursor || input.seenCursors.has(input.nextCursor))
  ) {
    throw new DeliveryError(`Delivery Project ${input.surface} pagination repeated a non-advancing cursor.`);
  }
}

function assertExactOptionSet(input: {
  expected: readonly string[];
  fieldName: string;
  options: readonly { name: string }[];
}): void {
  const observed = input.options.map((option) => option.name);
  const observedSet = new Set(observed);
  const expectedSet = new Set(input.expected);
  if (
    observedSet.size !== observed.length ||
    observedSet.size !== expectedSet.size ||
    observed.some((option) => !expectedSet.has(option))
  ) {
    throw new DeliveryError(
      `${input.fieldName} options must be exactly ${input.expected.join(', ')} (order is provider-owned).`,
    );
  }
}

function assertWritableConfiguration(configuration: ProjectDeliveryConfiguration): void {
  if (!configuration.writable) {
    throw new DeliveryError(
      `Organization Project #${String(configuration.projectNumber)} is not writable by this identity.`,
    );
  }
}

async function fetchProjectDeliveryItemNodes(
  input: Omit<ProjectDeliveryInput, 'issueNodeId'> & {
    configuration: ProjectDeliveryConfiguration;
    strictProjection?: boolean;
  },
): Promise<unknown[]> {
  const nodes: unknown[] = [];
  let cursor: null | string = null;
  let hasNextPage = true;
  const seenCursors = new Set<string>();
  let pages = 0;
  if (input.maxPages !== undefined && (!Number.isSafeInteger(input.maxPages) || input.maxPages <= 0))
    throw new DeliveryError('Project item page budget must be positive.');

  while (hasNextPage) {
    if (input.maxPages !== undefined && pages >= input.maxPages)
      throw new CollectionLimitError({
        collection: 'project-items',
        pagesRequested: pages,
        rowsObserved: nodes.length,
        limit: input.maxPages,
      });
    pages++;
    const response: unknown = await input.graphql(
      `
        query ProjectDeliveryItems($org: String!, $number: Int!, $cursor: String, $statusField: String!) {
          organization(login: $org) {
            projectV2(number: $number) {
              id
              number
              items(first: 100, after: $cursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
                nodes {
                  id
                  isArchived
                  content { __typename ... on Issue { id number repository { nameWithOwner } } ... on PullRequest { id } ... on DraftIssue { id } }
                  fieldValueByName(name: $statusField) {
                    ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
                  }
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }
      `,
      {
        cursor,
        number: input.configuration.projectNumber,
        org: input.org,
        statusField: input.configuration.settings.statusField,
      },
    );
    const record = requireRecord(response, 'GitHub returned invalid delivery Project item evidence.');
    if (input.strictProjection && 'errors' in record)
      throw new DeliveryError('GitHub returned partial Project item evidence.');
    const organization = requireRecord(record.organization, 'GitHub omitted the delivery Project organization.');
    const project = requireRecord(organization.projectV2, 'GitHub omitted the delivery Project.');
    if (
      (input.capacityRead || input.strictProjection) &&
      (project.id !== input.configuration.projectId || project.number !== input.configuration.projectNumber)
    )
      throw new DeliveryError('WIP capacity Project identity disagrees with the configured Project.');
    const items = requireRecord(project.items, 'GitHub omitted delivery Project items.');
    if (!Array.isArray(items.nodes)) {
      throw new DeliveryError('GitHub returned invalid delivery Project items.');
    }
    nodes.push(...(items.nodes as unknown[]));
    const pageInfo = requireRecord(items.pageInfo, 'GitHub omitted delivery Project item pagination.');
    if ((input.capacityRead || input.strictProjection) && typeof pageInfo.hasNextPage !== 'boolean')
      throw new DeliveryError('WIP capacity Project pagination is incomplete.');
    hasNextPage = pageInfo.hasNextPage === true;
    const nextCursor = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
    assertAdvancingCursor({ cursor, hasNextPage, nextCursor, seenCursors, surface: 'item' });
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return nodes;
}

async function findIssueProjectItem(
  input: ProjectDeliveryInput & { configuration: ProjectDeliveryConfiguration; refuseUnreadable?: boolean },
): Promise<null | ProjectDeliveryItem> {
  const matches: ProjectDeliveryItem[] = [];
  for (const raw of await fetchProjectDeliveryItemNodes(input)) {
    if (input.refuseUnreadable && (!isRecord(raw) || raw.content === null || raw.content === undefined))
      throw new DeliveryError('Project membership is unreadable; absence cannot be proved.');
    const item = parseProjectItem(raw, input.configuration, input.capacityRead);
    if (item?.contentId === input.issueNodeId) matches.push(item);
  }
  if (matches.length > 1)
    throw new DeliveryError(
      `Issue has ${String(matches.length)} duplicate Project items in ${input.configuration.title}.`,
    );
  return matches[0] ?? null;
}

export interface ProjectItemObservation extends ProjectDeliveryItem {
  projectId: string;
  projectNumber: number;
  contentKind: 'issue' | 'draft' | 'pull-request';
  statusRead: 'verified' | 'unset' | 'unreadable';
  statusName: string | null;
  repository?: string;
  issueNumber?: number;
}

/** Complete, strict reconciliation projection over the same Project pagination owner. */
export async function readProjectDeliveryItems(input: {
  graphql: typeof GraphQLType;
  org: string;
  configuration: ProjectDeliveryConfiguration;
  maxPages: number;
}): Promise<ProjectItemObservation[]> {
  const observations: ProjectItemObservation[] = [];
  const ids = new Set<string>();
  for (const raw of await fetchProjectDeliveryItemNodes({ ...input, strictProjection: true })) {
    const record = requireRecord(raw, 'GitHub returned invalid Project membership.');
    if (typeof record.isArchived !== 'boolean') throw new DeliveryError('Project archive projection is incomplete.');
    const content = requireRecord(record.content, 'Project content is unreadable; absence cannot be proved.');
    const kind = content.__typename;
    if (kind !== 'Issue' && kind !== 'DraftIssue' && kind !== 'PullRequest')
      throw new DeliveryError('Project content type is unreadable.');
    // Membership identity is independent of whether this item's Status is usable.
    let item = parseProjectItem({ ...record, fieldValueByName: null }, input.configuration);
    if (!item || ids.has(item.id)) throw new DeliveryError('Project item identity is missing or repeated.');
    let statusRead: ProjectItemObservation['statusRead'] = record.fieldValueByName === null ? 'unset' : 'unreadable';
    const rawStatus = isRecord(record.fieldValueByName) ? record.fieldValueByName : null;
    const safeText = (value: unknown): string | null =>
      typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
    const statusName = safeText(rawStatus?.name);
    if (record.fieldValueByName !== undefined && record.fieldValueByName !== null) {
      try {
        item = parseProjectItem(record, input.configuration)!;
        statusRead = 'verified';
      } catch {
        item.statusOptionId = safeText(rawStatus?.optionId);
      }
    }
    ids.add(item.id);
    const identity = {
      ...item,
      projectId: input.configuration.projectId,
      projectNumber: input.configuration.projectNumber,
      statusRead,
      statusName,
    };
    if (kind === 'Issue') {
      const repository = requireString(
        requireRecord(content.repository, 'Project issue repository is unreadable.').nameWithOwner,
        'Project issue repository is missing.',
      );
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
        !Number.isSafeInteger(content.number) ||
        Number(content.number) <= 0
      )
        throw new DeliveryError('Project issue identity is invalid.');
      observations.push({ ...identity, contentKind: 'issue', repository, issueNumber: Number(content.number) });
    } else observations.push({ ...identity, contentKind: kind === 'DraftIssue' ? 'draft' : 'pull-request' });
  }
  return observations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProjectItem(
  raw: unknown,
  configuration: ProjectDeliveryConfiguration,
  capacityRead = false,
): null | ProjectDeliveryItem {
  const item = requireRecord(raw, 'GitHub returned an invalid delivery Project item.');
  if (capacityRead && (typeof item.isArchived !== 'boolean' || item.fieldValueByName === undefined))
    throw new DeliveryError('WIP capacity Project status or archive evidence is missing.');
  const content = item.content;
  if (capacityRead && !item.isArchived && (content === null || content === undefined))
    throw new DeliveryError('WIP capacity Project item content is unreadable.');
  if (content === null || content === undefined) return null;
  const contentRecord = requireRecord(content, 'GitHub returned an invalid delivery Project item content node.');
  const contentId = requireString(contentRecord.id, 'GitHub omitted a delivery Project item content id.');
  const fieldValue = item.fieldValueByName;
  let status: null | ProjectDeliveryStatus = null;
  let statusOptionId: null | string = null;
  if (fieldValue !== null && fieldValue !== undefined) {
    const statusRecord = requireRecord(fieldValue, 'GitHub returned invalid Project Status readback.');
    const name = requireString(statusRecord.name, 'GitHub omitted Project Status name.');
    const optionId = requireString(statusRecord.optionId, 'GitHub omitted Project Status option id.');
    const statuses = configuration.settings.statuses;
    const canonicalStatus = PROJECT_DELIVERY_STATUSES.find((candidate) => statuses[candidate] === name);
    if (canonicalStatus === undefined || configuration.statusOptionIds[canonicalStatus] !== optionId) {
      throw new DeliveryError(`GitHub returned unsupported Project Status ${name}.`);
    }
    status = canonicalStatus;
    statusOptionId = optionId;
  }
  return {
    archived: item.isArchived === true,
    contentId,
    id: requireString(item.id, 'GitHub omitted the delivery Project item id.'),
    status,
    statusOptionId,
  };
}

async function readBackProjectArchiveState(input: {
  archived: boolean;
  configuration: ProjectDeliveryConfiguration;
  graphql: typeof GraphQLType;
  issueNodeId: string;
  itemId: string;
}): Promise<void> {
  const response: unknown = await input.graphql(
    `
      query ${input.archived ? 'Archived' : 'Restored'}ProjectDeliveryItemReadback($itemId: ID!) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            id
            isArchived
            project { id number }
            content { ... on Issue { id } }
          }
        }
      }
    `,
    { itemId: input.itemId },
  );
  const state = input.archived ? 'archived' : 'restored';
  const record = requireRecord(response, `GitHub returned invalid ${state} Project item readback.`);
  const node = requireRecord(record.node, `GitHub omitted ${state} Project item readback.`);
  const project = requireRecord(node.project, `GitHub omitted ${state} Project identity readback.`);
  const content = requireRecord(node.content, `GitHub omitted ${state} Project item content readback.`);
  if (
    node.id !== input.itemId ||
    node.isArchived !== input.archived ||
    project.id !== input.configuration.projectId ||
    project.number !== input.configuration.projectNumber ||
    content.id !== input.issueNodeId
  ) {
    throw new DeliveryError(`Project ${state} readback did not report the exact issue item.`);
  }
}

async function readBackProjectItem(input: {
  configuration: ProjectDeliveryConfiguration;
  graphql: typeof GraphQLType;
  issueNodeId: string;
  itemId: string;
  status: ProjectDeliveryStatus;
}): Promise<ProjectDeliveryStatusReadback> {
  const item = await readProjectItem(input);
  if (
    item.archived ||
    item.status !== input.status ||
    item.statusOptionId !== input.configuration.statusOptionIds[input.status]
  ) {
    throw new DeliveryError(`Project Status readback did not report ${input.status} for the exact issue item.`);
  }
  return { itemId: input.itemId, status: input.status };
}

async function readProjectItem(input: {
  capacityRead?: boolean;
  configuration: ProjectDeliveryConfiguration;
  graphql: typeof GraphQLType;
  issueNodeId: string;
  itemId: string;
}): Promise<ProjectDeliveryItem> {
  const response: unknown = await input.graphql(
    `
      query ProjectDeliveryItemReadback($itemId: ID!, $statusField: String!) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            id
            isArchived
            project { id number }
            content { ... on Issue { id } }
            fieldValueByName(name: $statusField) {
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
            }
          }
        }
      }
    `,
    { itemId: input.itemId, statusField: input.configuration.settings.statusField },
  );
  const record = requireRecord(response, 'GitHub returned invalid Project item readback.');
  const node = requireRecord(record.node, 'GitHub omitted Project item readback.');
  const project = requireRecord(node.project, 'GitHub omitted Project identity readback.');
  const content = requireRecord(node.content, 'GitHub omitted Project item content readback.');
  if (
    node.id !== input.itemId ||
    typeof node.isArchived !== 'boolean' ||
    project.id !== input.configuration.projectId ||
    project.number !== input.configuration.projectNumber ||
    content.id !== input.issueNodeId
  ) {
    throw new DeliveryError('Project Status readback did not report the exact issue item.');
  }
  const item = parseProjectItem(node, input.configuration, input.capacityRead);
  if (item === null) throw new DeliveryError('GitHub omitted Project item content readback.');
  return item;
}

function readOptions(raw: unknown, fieldName: string): { id: string; name: string }[] {
  if (!Array.isArray(raw)) {
    throw new DeliveryError(`${fieldName} options are malformed.`);
  }
  return raw.map((option) => {
    const record = requireRecord(option, `${fieldName} option is malformed.`);
    return {
      id: requireString(record.id, `${fieldName} option id is missing.`),
      name: requireString(record.name, `${fieldName} option name is missing.`),
    };
  });
}

function requireBoundIssueField(input: {
  expectedDatabaseId: string;
  expectedOptions: readonly string[];
  fields: unknown[];
  name: string;
}): Record<string, unknown> {
  const field = requireExactlyOneField(input.fields, input.name);
  if (field.__typename !== 'ProjectV2SingleSelectField' || field.isIssueField !== true) {
    throw new DeliveryError(`Project ${input.name} must bind the organization issue field.`);
  }
  if (Array.isArray(field.options) && field.options.length !== 0) {
    throw new DeliveryError(`Project ${input.name} must not define Project-owned duplicate options.`);
  }
  const issueField = requireRecord(
    field.issueField,
    `Project ${input.name} omitted its bound organization issue field.`,
  );
  const databaseId =
    typeof issueField.fullDatabaseId === 'string' ? issueField.fullDatabaseId : String(issueField.fullDatabaseId);
  if (
    issueField.__typename !== 'IssueFieldSingleSelect' ||
    issueField.name !== input.name ||
    databaseId !== input.expectedDatabaseId
  ) {
    throw new DeliveryError(`Project ${input.name} must bind organization issue field ${input.expectedDatabaseId}.`);
  }
  assertExactOptionSet({
    expected: input.expectedOptions,
    fieldName: input.name,
    options: readOptions(issueField.options, `organization ${input.name}`),
  });
  return field;
}

function requireExactlyOneField(fields: unknown[], name: string): Record<string, unknown> {
  const matches = fields.filter((field) => isRecord(field) && field.name === name);
  if (matches.length !== 1) {
    throw new DeliveryError(`Expected exactly one Project ${name} field, found ${String(matches.length)}.`);
  }
  return matches[0] as Record<string, unknown>;
}

function requireItemStatus(
  item: ProjectDeliveryItem,
  configuration: ProjectDeliveryConfiguration,
): ProjectDeliveryStatus {
  if (
    item.status === null ||
    item.statusOptionId === null ||
    configuration.statusOptionIds[item.status] !== item.statusOptionId
  ) {
    throw new DeliveryError('The issue delivery Project item has no canonical Project Status.');
  }
  return item.status;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DeliveryError(message);
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new DeliveryError(message);
  return value;
}

function requireProjectSettings(settings: ProjectDeliverySettings | undefined): ProjectDeliverySettings {
  if (settings === undefined) throw new DeliveryError('Project delivery settings are required.');
  return settings;
}
