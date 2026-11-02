import type { graphql as GraphQLType } from '@octokit/graphql';
import { z } from 'zod';

import { DeliveryError } from '../errors.js';

/** The two Project number fields every release G2 is scored on. Omission preserves; null clears. */
export const PROJECT_TRADE_FIELDS = {
  expectedTradesPerDay: 'Expected trades/day',
  measuredTradesPerDay: 'Measured trades/day',
} as const;
export type ProjectTradeKey = keyof typeof PROJECT_TRADE_FIELDS;
export type ProjectTradePatch = Partial<Record<ProjectTradeKey, number | null>>;

const TradesPerDay = z.number().finite().nonnegative().nullable().optional();
export const ProjectTradeFields = { expectedTradesPerDay: TradesPerDay, measuredTradesPerDay: TradesPerDay };

export function projectTradePatch(input: { [K in ProjectTradeKey]?: number | null | undefined }): ProjectTradePatch {
  return Object.fromEntries(
    (Object.keys(PROJECT_TRADE_FIELDS) as ProjectTradeKey[]).flatMap((key) =>
      input[key] === undefined ? [] : [[key, ProjectTradeFields[key].parse(input[key])]],
    ),
  );
}

/** The Project field ids for the requested numbers; refuses a field that is missing, duplicated or not a number. */
export async function readProjectTradeFieldIds(input: {
  graphql: typeof GraphQLType;
  keys: readonly ProjectTradeKey[];
  projectId: string;
}): Promise<Record<string, string>> {
  const catalog = await input.graphql<{
    node?: { fields?: { nodes?: { id?: string; name?: string; dataType?: string }[] } };
  }>(
    `query ProjectNumberFields($projectId: ID!) {
      node(id: $projectId) { ... on ProjectV2 { fields(first: 100) { nodes { ... on ProjectV2Field { id name dataType } } } } }
    }`,
    { projectId: input.projectId },
  );
  return Object.fromEntries(
    input.keys.map((key) => {
      const name = PROJECT_TRADE_FIELDS[key];
      const matches = (catalog.node?.fields?.nodes ?? []).filter((field) => field.name === name);
      if (matches.length !== 1 || matches[0]!.dataType !== 'NUMBER' || typeof matches[0]!.id !== 'string')
        throw new DeliveryError(
          `Expected one Project number field named ${name}. Add it to the Project as a Number field, then retry.`,
        );
      return [key, matches[0]!.id];
    }),
  );
}

/** Write the requested numbers on one Project item and read each back; the item must already be in the Project. */
export async function setProjectTradeNumbers(input: {
  fieldIds: Record<string, string>;
  graphql: typeof GraphQLType;
  itemId: string;
  patch: ProjectTradePatch;
  projectId: string;
}): Promise<Record<ProjectTradeKey, number | null>> {
  const keys = (Object.keys(input.patch) as ProjectTradeKey[]).filter((key) => input.patch[key] !== undefined);
  for (const key of keys) {
    const value = input.patch[key];
    const target = { fieldId: input.fieldIds[key]!, itemId: input.itemId, projectId: input.projectId };
    if (value === null || value === undefined)
      await input.graphql(
        `mutation ClearProjectNumber($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
          clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } }
        }`,
        target,
      );
    else
      await input.graphql(
        `mutation SetProjectNumber($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
          updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { number: $value } }) { projectV2Item { id } }
        }`,
        { ...target, value },
      );
  }
  const readback = await input.graphql<{ node?: Record<string, { number?: number } | null> }>(
    `query ProjectNumberReadback($itemId: ID!, $expected: String!, $measured: String!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          expectedTradesPerDay: fieldValueByName(name: $expected) { ... on ProjectV2ItemFieldNumberValue { number } }
          measuredTradesPerDay: fieldValueByName(name: $measured) { ... on ProjectV2ItemFieldNumberValue { number } }
        }
      }
    }`,
    {
      expected: PROJECT_TRADE_FIELDS.expectedTradesPerDay,
      itemId: input.itemId,
      measured: PROJECT_TRADE_FIELDS.measuredTradesPerDay,
    },
  );
  const result = {} as Record<ProjectTradeKey, number | null>;
  for (const key of Object.keys(PROJECT_TRADE_FIELDS) as ProjectTradeKey[])
    result[key] = readback.node?.[key]?.number ?? null;
  for (const key of keys)
    if (result[key] !== (input.patch[key] ?? null))
      throw new DeliveryError(
        `Project ${PROJECT_TRADE_FIELDS[key]} readback differs from the requested value. Read the issue's Project item, then retry.`,
      );
  return result;
}
