import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';

import { gitCommonDir } from '../git.js';
import { ensurePrivateDirectoryDurably, writePrivateJsonFileAtomically } from '../utils/atomicJson.js';
import { DeliveryError } from '../errors.js';
import { withLock } from '../utils/lockfile.js';

const deliveryRecordsPath = (root: string): string => join(gitCommonDir(root), 'ai-delivery', 'deliveries.json');
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

const DeliveryRecordSchema = z
  .object({
    blockerTimeMs: z.number().int().nonnegative().nullable(),
    cycleTimeMs: z.number().int().nonnegative(),
    firstPassApproved: z.boolean().nullable(),
    issueNumber: z.number().int().positive(),
    mergedAt: z.iso.datetime(),
    mergeSha: z.string().regex(/^[0-9a-f]{40}$/u),
    points: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    recordedAt: z.iso.datetime(),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    reviewRounds: z.number().int().positive().nullable(),
    schemaVersion: z.literal('ai-delivery.delivery-record@1'),
    terminalCleanupAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.terminalCleanupAt) < Date.parse(record.mergedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal cleanup cannot precede the merge.',
        path: ['terminalCleanupAt'],
      });
    }
    if (Date.parse(record.recordedAt) < Date.parse(record.terminalCleanupAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery recording cannot precede terminal cleanup.',
        path: ['recordedAt'],
      });
    }
  });

const DeliveryRecordFileSchema = z
  .object({
    records: z.array(DeliveryRecordSchema),
    schemaVersion: z.literal('ai-delivery.delivery-records@1'),
  })
  .strict();

export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

export interface PointBucketStatistics {
  blockerMeasurementCount: number;
  deliveries: number;
  firstPassRate: null | number;
  meanReviewRounds: null | number;
  medianBlockerTimeMs: null | number;
  medianCycleTimeMs: null | number;
  points: DeliveryRecord['points'];
}

export interface VelocityReport {
  planningCapacityPoints: number;
  pointBuckets: PointBucketStatistics[];
  rollingFourWeekMedianPoints: number;
  schemaVersion: 'ai-delivery.velocity-report@1';
  weeks: { end: string; mergedPoints: number; start: string }[];
}

export function buildVelocityReport(
  records: readonly DeliveryRecord[],
  now = new Date(),
  configuredPoints: readonly number[] = [],
): VelocityReport {
  if (!Number.isFinite(now.getTime())) {
    throw new DeliveryError('Velocity report requires a valid observation time.');
  }
  const endMs = now.getTime();
  const startMs = endMs - 4 * MS_PER_WEEK;
  const selected = records.filter((record) => {
    const mergedMs = Date.parse(record.mergedAt);
    return mergedMs >= startMs && mergedMs < endMs;
  });
  const weeks = Array.from({ length: 4 }, (_, index) => {
    const weekStart = startMs + index * MS_PER_WEEK;
    const weekEnd = weekStart + MS_PER_WEEK;
    return {
      end: new Date(weekEnd).toISOString(),
      mergedPoints: selected
        .filter((record) => {
          const mergedMs = Date.parse(record.mergedAt);
          return mergedMs >= weekStart && mergedMs < weekEnd;
        })
        .reduce((sum, record) => sum + record.points, 0),
      start: new Date(weekStart).toISOString(),
    };
  });
  const rollingFourWeekMedianPoints = median(weeks.map((week) => week.mergedPoints)) ?? 0;

  return {
    planningCapacityPoints: Math.floor(rollingFourWeekMedianPoints * 0.8),
    pointBuckets: [...new Set([...configuredPoints, ...selected.map((record) => record.points)])]
      .sort((left, right) => left - right)
      .map((points) => pointBucket(points, selected)),
    rollingFourWeekMedianPoints,
    schemaVersion: 'ai-delivery.velocity-report@1',
    weeks,
  };
}

export function getDeliveryRecords(projectRoot = process.cwd()): DeliveryRecord[] {
  const path = deliveryRecordsPath(projectRoot);
  if (!existsSync(path)) {
    return [];
  }
  try {
    return DeliveryRecordFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).records;
  } catch (error: unknown) {
    throw new DeliveryError(
      `Delivery record store is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function recordMergedDeliveries(
  candidates: readonly DeliveryRecord[],
  projectRoot = process.cwd(),
): Promise<{ records: DeliveryRecord[]; state: 'already-recorded' | 'recorded' }> {
  if (candidates.length === 0) {
    throw new DeliveryError('Delivery recording requires at least one merged delivery.');
  }
  const candidateRecords = candidates.map((candidate) => DeliveryRecordSchema.parse(candidate));
  ensurePrivateDirectoryDurably(join(gitCommonDir(projectRoot), 'ai-delivery'));
  return await withLock(join(gitCommonDir(projectRoot), 'ai-delivery'), {
    operation: () => {
      const records = getDeliveryRecords(projectRoot);
      const pending: DeliveryRecord[] = [];
      for (const candidate of candidateRecords) {
        const existing = [...records, ...pending].find((value) => sameDeliveryIdentity(value, candidate));
        if (existing !== undefined && !sameImmutableFacts(existing, candidate)) {
          throw new DeliveryError('Delivery facts conflict with the existing immutable delivery record.');
        }
        if (existing === undefined) {
          pending.push(candidate);
        }
      }
      if (pending.length > 0) {
        writePrivateJsonFileAtomically(deliveryRecordsPath(projectRoot), {
          records: [...records, ...pending].sort(compareDeliveryRecords),
          schemaVersion: 'ai-delivery.delivery-records@1',
        });
      }
      const readback = getDeliveryRecords(projectRoot);
      const persisted = candidateRecords.map((candidate) => {
        const match = readback.find((value) => sameDeliveryIdentity(value, candidate));
        if (match === undefined || !sameImmutableFacts(match, candidate)) {
          throw new DeliveryError('Delivery record readback did not match the merged delivery.');
        }
        return match;
      });
      return {
        records: persisted,
        state: pending.length === 0 ? ('already-recorded' as const) : ('recorded' as const),
      };
    },
    projectRoot,
    timeout: 5000,
  });
}

export async function recordMergedDelivery(
  candidate: DeliveryRecord,
  projectRoot = process.cwd(),
): Promise<{ record: DeliveryRecord; state: 'already-recorded' | 'recorded' }> {
  const result = await recordMergedDeliveries([candidate], projectRoot);
  const [record] = result.records;
  if (record === undefined) {
    throw new DeliveryError('Delivery record batch did not return the merged delivery.');
  }
  return { record, state: result.state };
}

function compareDeliveryRecords(left: DeliveryRecord, right: DeliveryRecord): number {
  return (
    left.repository.localeCompare(right.repository) ||
    left.issueNumber - right.issueNumber ||
    left.mergeSha.localeCompare(right.mergeSha)
  );
}

function median(values: readonly number[]): null | number {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    return null;
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function pointBucket(points: DeliveryRecord['points'], records: readonly DeliveryRecord[]): PointBucketStatistics {
  const matches = records.filter((record) => record.points === points);
  const blockerMeasurements = matches.flatMap((record) =>
    record.blockerTimeMs === null ? [] : [record.blockerTimeMs],
  );
  const firstPassMeasurements = matches.filter((record) => record.firstPassApproved !== null);
  const reviewMeasurements = matches.flatMap((record) => (record.reviewRounds === null ? [] : [record.reviewRounds]));
  return {
    blockerMeasurementCount: blockerMeasurements.length,
    deliveries: matches.length,
    firstPassRate:
      firstPassMeasurements.length === 0
        ? null
        : firstPassMeasurements.filter((record) => record.firstPassApproved).length / firstPassMeasurements.length,
    meanReviewRounds:
      reviewMeasurements.length === 0
        ? null
        : reviewMeasurements.reduce((sum, rounds) => sum + rounds, 0) / reviewMeasurements.length,
    medianBlockerTimeMs: median(blockerMeasurements),
    medianCycleTimeMs: median(matches.map((record) => record.cycleTimeMs)),
    points,
  };
}

function sameDeliveryIdentity(left: DeliveryRecord, right: DeliveryRecord): boolean {
  return (
    left.repository === right.repository && left.issueNumber === right.issueNumber && left.mergeSha === right.mergeSha
  );
}

function sameImmutableFacts(left: DeliveryRecord, right: DeliveryRecord): boolean {
  return (
    left.blockerTimeMs === right.blockerTimeMs &&
    left.cycleTimeMs === right.cycleTimeMs &&
    left.firstPassApproved === right.firstPassApproved &&
    left.issueNumber === right.issueNumber &&
    left.mergeSha === right.mergeSha &&
    left.mergedAt === right.mergedAt &&
    left.points === right.points &&
    left.repository === right.repository &&
    left.reviewRounds === right.reviewRounds
  );
}
