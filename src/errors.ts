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
    }),
  );
}

export function getMachineRequestDiagnostics(error: unknown): Readonly<SafeMachineRequestDiagnostics> | undefined {
  return typeof error === 'object' && error !== null ? diagnostics.get(error as DeliveryError) : undefined;
}
