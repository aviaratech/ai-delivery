import type { DeliveryConfig } from '../config/deliveryConfig.js';

import { DeliveryError } from '../errors.js';

export const NATIVE_ISSUE_API_VERSION = '2026-03-10';

export interface ConfiguredNativeIssueMetadata {
  points?: number;
  priority?: string;
}
export interface NativeIssueFieldCatalog {
  points: NativeIssueFieldReference;
  priority: NativeIssueFieldReference;
}

export interface NativeIssueFieldReference {
  dataType: 'single_select';
  id: number;
  name: string;
}

export interface NativeIssueSettings {
  points: { databaseId: string; name: string; values: readonly number[] };
  priority: { databaseId: string; name: string; values: readonly string[] };
}

export interface NativeIssueMetadataRest {
  request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export type NativePointValue = number;
export type NativePriorityValue = string;

interface RawIssueField {
  data_type?: unknown;
  id?: unknown;
  name?: unknown;
  options?: unknown;
}

interface RawIssueFieldValue {
  data_type?: unknown;
  issue_field_id?: unknown;
  issue_field_name?: unknown;
  single_select_option?: unknown;
  value?: unknown;
}

export function nativeIssueSettingsFromDeliveryConfig(config: Pick<DeliveryConfig, 'native'>): NativeIssueSettings {
  return {
    points: {
      databaseId: config.native.points.databaseId,
      name: config.native.points.name,
      values: config.native.points.values.map((value) => Number(value)),
    },
    priority: {
      databaseId: config.native.priority.databaseId,
      name: config.native.priority.name,
      values: config.native.priority.values,
    },
  };
}

export function validateConfiguredNativeTracking(input: {
  blockedBy?: readonly number[];
  config: Pick<DeliveryConfig, 'native'>;
  issueNumber?: number;
  issueType: string;
  milestone?: number;
  parentIssueNumber?: number;
  points: number;
  priority: string;
}): void {
  const { config } = input;
  if (!config.native.issueTypes.includes(input.issueType)) {
    throw new DeliveryError(`Unsupported native issue type ${input.issueType}.`);
  }
  const settings = nativeIssueSettingsFromDeliveryConfig(config);
  if (!settings.points.values.includes(input.points)) {
    throw new DeliveryError(`Unsupported native ${settings.points.name} value.`);
  }
  if (!settings.priority.values.includes(input.priority)) {
    throw new DeliveryError(`Unsupported native ${settings.priority.name} value.`);
  }
  for (const [name, value] of [
    ['milestone', input.milestone],
    ['parent', input.parentIssueNumber],
    ...(input.blockedBy ?? []).map((value) => ['blocker', value] as const),
  ] as const) {
    assertPositiveNativeNumber(name, value);
  }
  if (
    input.issueNumber !== undefined &&
    (input.parentIssueNumber === input.issueNumber || (input.blockedBy ?? []).includes(input.issueNumber))
  ) {
    throw new DeliveryError('An issue cannot be its own parent or blocker.');
  }
  if (new Set(input.blockedBy ?? []).size !== (input.blockedBy ?? []).length) {
    throw new DeliveryError('Native blockers must be unique.');
  }
}

function assertPositiveNativeNumber(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new DeliveryError(`Native ${name} must be a positive issue or milestone number.`);
  }
}

const apiHeaders = { 'X-GitHub-Api-Version': NATIVE_ISSUE_API_VERSION } as const;

export async function clearConfiguredNativeIssuePoints(input: {
  catalog?: NativeIssueFieldCatalog;
  issueNumber: number;
  org: string;
  owner: string;
  repo: string;
  rest: NativeIssueMetadataRest;
  settings: NativeIssueSettings;
}): Promise<void> {
  const existing = await getConfiguredNativeIssueMetadata(input);
  if (existing.points === undefined) {
    return;
  }
  const catalog = input.catalog ?? (await getConfiguredNativeIssueFieldCatalog(input));
  assertCatalogMatchesSettings(catalog, input.settings);
  await input.rest.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values/{issue_field_id}', {
    headers: apiHeaders,
    issue_field_id: catalog.points.id,
    issue_number: input.issueNumber,
    owner: input.owner,
    repo: input.repo,
  });
  const readback = await getConfiguredNativeIssueMetadata(input);
  if (readback.points !== undefined) {
    throw new DeliveryError(
      `Native issue metadata readback retained Points ${String(readback.points)} after clearing issue #${String(input.issueNumber)}.`,
    );
  }
}

export async function getConfiguredNativeIssueFieldCatalog(input: {
  org: string;
  rest: NativeIssueMetadataRest;
  settings: NativeIssueSettings;
}): Promise<NativeIssueFieldCatalog> {
  const response = await input.rest.request('GET /orgs/{org}/issue-fields', {
    headers: apiHeaders,
    org: input.org,
  });
  return resolveNativeIssueFieldCatalog(response.data, input.settings);
}

export async function getConfiguredNativeIssueMetadata(input: {
  issueNumber: number;
  owner: string;
  repo: string;
  rest: NativeIssueMetadataRest;
  settings: NativeIssueSettings;
}): Promise<ConfiguredNativeIssueMetadata> {
  const response = await input.rest.request('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', {
    headers: apiHeaders,
    issue_number: input.issueNumber,
    owner: input.owner,
    repo: input.repo,
  });
  return parseConfiguredNativeIssueMetadata(response.data, input.settings);
}

export function parseConfiguredNativeIssueMetadata(
  raw: unknown,
  settings: NativeIssueSettings,
): ConfiguredNativeIssueMetadata {
  if (!Array.isArray(raw)) {
    throw new DeliveryError('GitHub returned an invalid issue-field value payload.');
  }

  const metadata: ConfiguredNativeIssueMetadata = {};
  const seen = new Set<NativeIssueFieldReference['name']>();
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue;
    }
    const value = candidate as RawIssueFieldValue;
    const name = value.issue_field_name;
    assertConfiguredReadbackField({ seen, settings, value });
    if (name === settings.points.name) {
      metadata.points = parseConfiguredPoints(value, settings);
    } else if (name === settings.priority.name) {
      metadata.priority = parseConfiguredPriority(value, settings);
    }
  }
  return metadata;
}

export function resolveNativeIssueFieldCatalog(raw: unknown, settings: NativeIssueSettings): NativeIssueFieldCatalog {
  if (!Array.isArray(raw)) {
    throw new DeliveryError('GitHub returned an invalid organization issue-field payload.');
  }
  const fields = raw.filter((value): value is RawIssueField => typeof value === 'object' && value !== null);
  return {
    points: resolveSingleSelectField({
      expectedId: settings.points.databaseId,
      expectedValues: settings.points.values.map(String),
      fields,
      name: settings.points.name,
    }),
    priority: resolveSingleSelectField({
      expectedId: settings.priority.databaseId,
      expectedValues: settings.priority.values,
      fields,
      name: settings.priority.name,
    }),
  };
}

export async function setConfiguredNativeIssueMetadata(input: {
  catalog?: NativeIssueFieldCatalog;
  issueNumber: number;
  metadata: ConfiguredNativeIssueMetadata;
  org: string;
  owner: string;
  repo: string;
  rest: NativeIssueMetadataRest;
  settings: NativeIssueSettings;
}): Promise<ConfiguredNativeIssueMetadata> {
  if (input.metadata.points === undefined && input.metadata.priority === undefined) {
    return {};
  }
  const catalog = input.catalog ?? (await getConfiguredNativeIssueFieldCatalog(input));
  assertCatalogMatchesSettings(catalog, input.settings);
  const issueFieldValues: { field_id: number; value: string }[] = [];
  if (input.metadata.points !== undefined) {
    if (!input.settings.points.values.includes(input.metadata.points)) {
      throw new DeliveryError(`Unsupported ${input.settings.points.name} value.`);
    }
    issueFieldValues.push({ field_id: catalog.points.id, value: String(input.metadata.points) });
  }
  if (input.metadata.priority !== undefined) {
    if (!input.settings.priority.values.includes(input.metadata.priority)) {
      throw new DeliveryError(`Unsupported ${input.settings.priority.name} value.`);
    }
    issueFieldValues.push({ field_id: catalog.priority.id, value: input.metadata.priority });
  }
  if (issueFieldValues.length === 0) {
    return {};
  }

  const response = await input.rest.request('POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', {
    headers: apiHeaders,
    issue_field_values: issueFieldValues,
    issue_number: input.issueNumber,
    owner: input.owner,
    repo: input.repo,
  });
  const readback = parseConfiguredNativeIssueMetadata(response.data, input.settings);
  assertReadback(input.metadata, readback);
  return readback;
}

function assertCatalogMatchesSettings(catalog: NativeIssueFieldCatalog, settings: NativeIssueSettings): void {
  for (const field of ['points', 'priority'] as const) {
    const actual = catalog[field];
    const expected = settings[field];
    if (
      !Number.isSafeInteger(actual.id) ||
      actual.id <= 0 ||
      actual.name !== expected.name ||
      String(actual.id) !== expected.databaseId
    ) {
      throw new DeliveryError(`Native ${expected.name} catalog does not match configured issue field.`);
    }
  }
  if (catalog.points.id === catalog.priority.id) {
    throw new DeliveryError('Native Points and Priority catalogs must select distinct issue fields.');
  }
}

function assertConfiguredReadbackField(input: {
  seen: Set<string>;
  settings: NativeIssueSettings;
  value: RawIssueFieldValue;
}): void {
  const { seen, settings, value } = input;
  const name = value.issue_field_name;
  if (name !== settings.points.name && name !== settings.priority.name) return;
  if (seen.has(name)) {
    throw new DeliveryError(`GitHub returned duplicate native ${name} field values.`);
  }
  seen.add(name);
  if (value.data_type !== 'single_select') {
    throw new DeliveryError(`Native ${name} readback must be a constrained single-select field value.`);
  }
  const expectedId = name === settings.points.name ? settings.points.databaseId : settings.priority.databaseId;
  if (expectedId !== undefined && String(value.issue_field_id) !== expectedId) {
    throw new DeliveryError(`Native ${name} readback does not match configured issue field.`);
  }
}

function assertReadback(expected: ConfiguredNativeIssueMetadata, actual: ConfiguredNativeIssueMetadata): void {
  for (const key of ['points', 'priority'] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) {
      throw new DeliveryError(
        `Native issue metadata readback mismatch for ${key}: expected ${String(expected[key])}, found ${String(actual[key])}.`,
      );
    }
  }
}

function parseConfiguredPoints(value: RawIssueFieldValue, settings: NativeIssueSettings): number {
  const rendered = readFieldValue(value);
  const points = typeof rendered === 'number' ? rendered : Number(rendered);
  if (
    !Number.isSafeInteger(points) ||
    !settings.points.values.includes(points) ||
    (settings.points.databaseId !== undefined && String(rendered) !== String(points))
  ) {
    throw new DeliveryError(`GitHub returned unsupported ${settings.points.name} value ${String(rendered)}.`);
  }
  return points;
}

function parseConfiguredPriority(value: RawIssueFieldValue, settings: NativeIssueSettings): string {
  const rendered = readFieldValue(value);
  if (typeof rendered !== 'string' || !settings.priority.values.includes(rendered)) {
    throw new DeliveryError(`GitHub returned unsupported ${settings.priority.name} value ${String(rendered)}.`);
  }
  return rendered;
}

function readFieldValue(value: RawIssueFieldValue): unknown {
  if (typeof value.single_select_option === 'object' && value.single_select_option !== null) {
    const option = value.single_select_option as { name?: unknown };
    if (option.name !== undefined) {
      return option.name;
    }
  }
  return value.value;
}

function resolveSingleSelectField({
  expectedId,
  expectedValues,
  fields,
  name,
}: {
  expectedId?: string | undefined;
  expectedValues?: readonly string[] | undefined;
  fields: RawIssueField[];
  name: string;
}): NativeIssueFieldReference {
  const matches = fields.filter((field) => field.name === name);
  if (matches.length !== 1) {
    throw new DeliveryError(`Expected exactly one native ${name} issue field, found ${String(matches.length)}.`);
  }
  const [field] = matches;
  if (field === undefined || field.data_type !== 'single_select' || !Number.isSafeInteger(field.id)) {
    throw new DeliveryError(`Native ${name} must be a constrained single-select issue field.`);
  }
  if (expectedId !== undefined && String(field.id) !== expectedId) {
    throw new DeliveryError(`Native ${name} does not match configured issue field ${expectedId}.`);
  }
  if (expectedValues !== undefined) {
    const options = Array.isArray(field.options)
      ? field.options.map((option) =>
          typeof option === 'object' && option !== null ? (option as { name?: unknown }).name : null,
        )
      : [];
    if (
      options.length !== expectedValues.length ||
      new Set(options).size !== expectedValues.length ||
      options.some((option) => typeof option !== 'string' || !expectedValues.includes(option))
    ) {
      throw new DeliveryError(`Native ${name} options do not match configured values.`);
    }
  }
  return { dataType: 'single_select', id: field.id as number, name };
}
