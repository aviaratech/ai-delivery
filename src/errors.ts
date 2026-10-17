import { types } from 'node:util';

export class DeliveryError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'DeliveryError';
    this.hint = hint;
  }
}

const phases = ['rest.request', 'graphql.request'] as const;
const endpoints = [
  'pulls.merge',
  'pulls.get',
  'pulls.listReviews',
  'pulls.getReview',
  'git.getCommit',
  'git.getRef',
  'issues.get',
  'issues.update',
  'graphql',
] as const;
const codes = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
] as const;
export interface SafeMachineRequestDiagnostics {
  readonly phase: (typeof phases)[number] | 'UNKNOWN';
  readonly endpoint: (typeof endpoints)[number] | 'UNKNOWN';
  readonly status: number | 'UNKNOWN';
  readonly code: (typeof codes)[number] | 'UNKNOWN';
  readonly requestId: string;
  readonly rateLimit?: RateLimitDiagnostics;
}
export interface RateLimitDiagnostics {
  readonly retryAfterSeconds?: number;
  readonly resetAtSeconds?: number;
  readonly remaining?: number;
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function numericHeader(value: unknown): number | undefined {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/u.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function rateLimit(
  status: unknown,
  retryAfter: unknown,
  resetAt: unknown,
  remainingValue: unknown,
  graphqlFailure = false,
): RateLimitDiagnostics | undefined {
  const retryAfterSeconds = numericHeader(retryAfter);
  const resetAtSeconds = numericHeader(resetAt);
  const remaining = numericHeader(remainingValue);
  if (
    status !== 429 &&
    !(status === 403 && (retryAfterSeconds !== undefined || remaining === 0)) &&
    !(graphqlFailure && remaining === 0)
  )
    return undefined;
  return Object.freeze({
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(resetAtSeconds === undefined ? {} : { resetAtSeconds }),
    ...(remaining === undefined ? {} : { remaining }),
  });
}

/** Preserve only positive rate-limit identification and numeric timing, never remote error content. */
export function getRateLimitDiagnostics(error: unknown, graphqlFailure = false): RateLimitDiagnostics | undefined {
  const retained = getMachineRequestDiagnostics(error)?.rateLimit;
  if (retained !== undefined) return retained;
  const headers = ownData(error, 'headers') ?? ownData(ownData(error, 'response'), 'headers');
  return rateLimit(
    ownData(error, 'status'),
    ownData(headers, 'retry-after'),
    ownData(headers, 'x-ratelimit-reset'),
    ownData(headers, 'x-ratelimit-remaining'),
    graphqlFailure,
  );
}
const diagnostics = new WeakMap<DeliveryError, Readonly<SafeMachineRequestDiagnostics>>();

export function setMachineRequestDiagnostics(
  error: DeliveryError,
  input: {
    phase: unknown;
    endpoint: unknown;
    status: unknown;
    code: unknown;
    requestId: unknown;
    retryAfter?: unknown;
    resetAt?: unknown;
    remaining?: unknown;
  },
): void {
  if (!(error instanceof DeliveryError) || diagnostics.has(error)) return;
  const data = (name: string): unknown => {
    if (typeof input !== 'object' || input === null || types.isProxy(input) || Array.isArray(input)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const member = <T extends string>(value: unknown, allowed: readonly T[]): T | 'UNKNOWN' =>
    typeof value === 'string' && allowed.includes(value as T) ? (value as T) : 'UNKNOWN';
  const status = data('status'),
    requestId = data('requestId');
  const observedRateLimit = rateLimit(
    status,
    data('retryAfter'),
    data('resetAt'),
    data('remaining'),
    data('phase') === 'graphql.request',
  );
  diagnostics.set(
    error,
    Object.freeze({
      phase: member(data('phase'), phases),
      endpoint: member(data('endpoint'), endpoints),
      status:
        typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599
          ? status
          : 'UNKNOWN',
      code: member(data('code'), codes),
      requestId:
        typeof requestId === 'string' &&
        requestId.length <= 128 &&
        /^[A-Fa-f0-9]{4}(?::[A-Fa-f0-9]{4,32}){3,5}$/u.test(requestId)
          ? requestId
          : 'UNKNOWN',
      ...(observedRateLimit === undefined ? {} : { rateLimit: observedRateLimit }),
    }),
  );
}

export function getMachineRequestDiagnostics(error: unknown): Readonly<SafeMachineRequestDiagnostics> | undefined {
  return typeof error === 'object' && error !== null ? diagnostics.get(error as DeliveryError) : undefined;
}
