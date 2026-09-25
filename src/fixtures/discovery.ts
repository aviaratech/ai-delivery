import type { DeliveryConfig, DeliveryOverrides } from '../config/deliveryConfig.js';
import type { DiscoveryClients } from '../github/discovery.js';

export const syntheticDiscoveryConfig: Pick<DeliveryConfig, 'native' | 'repository'> = {
  repository: 'example/widget',
  native: {
    organization: 'example',
    issueTypes: ['Task'],
    milestones: 'repository',
    points: { databaseId: '101', name: 'Estimate', values: ['1', '2', '4'] },
    priority: { databaseId: '102', name: 'Urgency', values: ['High', 'Low'] },
    project: {
      number: 1,
      title: 'Delivery',
      statusField: 'Flow',
      statuses: { blocked: 'Waiting', done: 'Shipped', inProgress: 'Active', todo: 'Queued' },
    },
    relationships: { blockedBy: 'native', parent: 'native' },
  },
};

export function syntheticOverrides(config: Pick<DeliveryConfig, 'native' | 'repository'>): DeliveryOverrides {
  return {
    schemaVersion: 'ai-delivery.config@2',
    repository: config.repository,
    policy: { module: './policy.mjs' },
    project: config.native.project.number,
    pointsField: config.native.points.name,
    priorityField: config.native.priority.name,
    statusField: config.native.project.statusField,
    statuses: config.native.project.statuses,
    issueTypes: config.native.issueTypes,
  };
}

export function syntheticDiscoveryClients(config = syntheticDiscoveryConfig): DiscoveryClients {
  const native = config.native;
  const field = (value: DeliveryConfig['native']['points']) => ({
    __typename: 'IssueFieldSingleSelect',
    id: `ISSUE-FIELD-${value.databaseId}`,
    fullDatabaseId: value.databaseId,
    name: value.name,
    options: value.values.map((name, index) => ({ id: `${value.databaseId}-${index}`, name })),
  });
  const projectField = (value: DeliveryConfig['native']['points']) => ({
    __typename: 'ProjectV2SingleSelectField',
    id: `PROJECT-FIELD-${value.databaseId}`,
    name: value.name,
    isIssueField: true,
    options: [],
    issueField: field(value),
  });
  const status = {
    __typename: 'ProjectV2SingleSelectField',
    id: 'STATUS-FIELD',
    name: native.project.statusField,
    isIssueField: false,
    options: [
      native.project.statuses.todo,
      native.project.statuses.inProgress,
      native.project.statuses.blocked,
      native.project.statuses.done,
    ].map((name, index) => ({ id: `STATUS-${index}`, name })),
  };
  const project = {
    id: `PROJECT-${native.project.number}`,
    number: native.project.number,
    title: native.project.title,
    closed: false,
    viewerCanUpdate: true,
    owner: { __typename: 'Organization', login: native.organization },
    fields: {
      nodes: [status, projectField(native.points), projectField(native.priority)],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  const graphql = async (query: string): Promise<unknown> => {
    if (query.includes('query DeliveryRepository'))
      return {
        repository: { id: 'REPO', nameWithOwner: config.repository, isFork: false, owner: project.owner },
      };
    if (query.includes('query ProjectDeliveryConfiguration')) return { organization: { projectV2: project } };
    const page = (nodes: unknown[]): unknown => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    if (query.includes('issueFields(first:'))
      return { repository: { issueFields: page([field(native.points), field(native.priority)]) } };
    if (query.includes('issueTypes(first:'))
      return {
        repository: {
          issueTypes: page(native.issueTypes.map((name, index) => ({ id: `TYPE-${index}`, name, isEnabled: true }))),
        },
      };
    if (query.includes('projectsV2(first:')) return { repository: { projectsV2: page([project]) } };
    throw new Error('Unexpected synthetic discovery query.');
  };
  return { graphql: graphql as DiscoveryClients['graphql'] };
}
