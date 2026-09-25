import type { graphql as GraphQLType } from '@octokit/graphql';
import type { DeliveryConfig } from '../config/deliveryConfig.js';

import { DeliveryError } from '../errors.js';

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
  const item = await findIssueProjectItem({ ...input, configuration });
  if (item === null || item.archived) return null;
  if (item.status === null && item.statusOptionId === null) return null;
  const status = requireItemStatus(item, configuration);
  return { itemId: item.id, status };
}

export async function getProjectDeliveryConfiguration(input: {
  graphql: typeof GraphQLType;
  org: string;
  requireWritable?: boolean;
  settings: ProjectDeliverySettings;
}): Promise<ProjectDeliveryConfiguration> {
  const settings = requireProjectSettings(input.settings);
  const nodes: unknown[] = [];
  let cursor: null | string = null;
  let hasNextPage = true;
  const seenCursors = new Set<string>();
  let project: null | Record<string, unknown> = null;

  while (hasNextPage) {
    const response: unknown = await input.graphql(
      `
        query ProjectDeliveryConfiguration($org: String!, $number: Int!, $cursor: String) {
          organization(login: $org) {
            projectV2(number: $number) {
              id
              number
              title
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
      { cursor, number: settings.number, org: input.org },
    );
    const responseRecord = requireRecord(response, 'GitHub returned invalid delivery Project configuration.');
    const organization = requireRecord(
      responseRecord.organization,
      `Organization ${input.org} is unavailable to the selected GitHub identity.`,
    );
    const pageProject = requireRecord(
      organization.projectV2,
      `Expected organization Project #${String(settings.number)} (${settings.title}).`,
    );
    const fields = requireRecord(pageProject.fields, 'GitHub omitted delivery Project fields.');
    if (!Array.isArray(fields.nodes)) {
      throw new DeliveryError('GitHub returned invalid delivery Project field nodes.');
    }
    for (const node of fields.nodes) nodes.push(node as unknown);
    project = { ...pageProject, fields: { nodes } };
    const pageInfo = requireRecord(fields.pageInfo, 'GitHub omitted delivery Project field pagination.');
    hasNextPage = pageInfo.hasNextPage === true;
    const nextCursor = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
    assertAdvancingCursor({ cursor, hasNextPage, nextCursor, seenCursors, surface: 'field' });
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (project === null) {
    throw new DeliveryError(`Expected organization Project #${String(settings.number)} (${settings.title}).`);
  }
  return resolveProjectDeliveryConfiguration(project, {
    requireWritable: input.requireWritable === true,
    settings,
  });
}

export function projectSettingsFromDeliveryConfig(config: DeliveryConfig): ProjectDeliverySettings {
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

export async function syncIssueProjectStatus(
  input: ProjectDeliveryInput & { status: ProjectDeliveryStatus },
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
    item = {
      archived: false,
      contentId: input.issueNodeId,
      id: requireString(created.id, 'GitHub omitted the created Project item id.'),
      status: null,
      statusOptionId: null,
    };
  }

  const optionId = configuration.statusOptionIds[input.status];
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

async function findIssueProjectItem(
  input: ProjectDeliveryInput & { configuration: ProjectDeliveryConfiguration },
): Promise<null | ProjectDeliveryItem> {
  const matches: ProjectDeliveryItem[] = [];
  let cursor: null | string = null;
  let hasNextPage = true;
  const seenCursors = new Set<string>();

  while (hasNextPage) {
    const response: unknown = await input.graphql(
      `
        query ProjectDeliveryItems($org: String!, $number: Int!, $cursor: String, $statusField: String!) {
          organization(login: $org) {
            projectV2(number: $number) {
              items(first: 100, after: $cursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
                nodes {
                  id
                  isArchived
                  content { ... on Issue { id } }
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
    const organization = requireRecord(record.organization, 'GitHub omitted the delivery Project organization.');
    const project = requireRecord(organization.projectV2, 'GitHub omitted the delivery Project.');
    const items = requireRecord(project.items, 'GitHub omitted delivery Project items.');
    if (!Array.isArray(items.nodes)) {
      throw new DeliveryError('GitHub returned invalid delivery Project items.');
    }
    for (const rawItem of items.nodes) {
      const item = parseProjectItem(rawItem, input.configuration);
      if (item !== null && item.contentId === input.issueNodeId) matches.push(item);
    }
    const pageInfo = requireRecord(items.pageInfo, 'GitHub omitted delivery Project item pagination.');
    hasNextPage = pageInfo.hasNextPage === true;
    const nextCursor = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
    assertAdvancingCursor({ cursor, hasNextPage, nextCursor, seenCursors, surface: 'item' });
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (matches.length > 1) {
    throw new DeliveryError(
      `Issue has ${String(matches.length)} duplicate Project items in ${input.configuration.title}.`,
    );
  }
  return matches[0] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProjectItem(raw: unknown, configuration: ProjectDeliveryConfiguration): null | ProjectDeliveryItem {
  const item = requireRecord(raw, 'GitHub returned an invalid delivery Project item.');
  const content = item.content;
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
  const fieldValue = requireRecord(node.fieldValueByName, 'GitHub omitted Project Status readback.');
  const observedName = requireString(fieldValue.name, 'GitHub omitted Project Status name readback.');
  const observedOptionId = requireString(fieldValue.optionId, 'GitHub omitted Project Status option readback.');
  if (
    node.id !== input.itemId ||
    node.isArchived === true ||
    project.id !== input.configuration.projectId ||
    project.number !== input.configuration.projectNumber ||
    content.id !== input.issueNodeId ||
    observedName !== input.configuration.settings.statuses[input.status] ||
    observedOptionId !== input.configuration.statusOptionIds[input.status]
  ) {
    throw new DeliveryError(`Project Status readback did not report ${input.status} for the exact issue item.`);
  }
  return { itemId: input.itemId, status: input.status };
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
