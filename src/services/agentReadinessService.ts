import type { NativePointValue } from '../github/nativeIssueMetadata.js';
import {
  parseIssueBody,
  validateIssue,
  issueWarnings,
  IssueValidationError,
  type IssueDiagnostic,
} from '../issueContract.js';

export interface AgentReadinessResult {
  failures: IssueDiagnostic[];
  warnings: IssueDiagnostic[];
  ready: boolean;
}
export type ReadinessFailureCode = string;

/** Content validation is repository-independent; GitHub owns live eligibility. */
export function evaluateAgentReadiness(input: {
  blockedBy?: readonly number[];
  body: string;
  points?: NativePointValue | undefined;
  repoRoot?: string | undefined;
  title: string;
  issueType?: string;
  trackingParent?: boolean;
}): AgentReadinessResult {
  const failures: IssueDiagnostic[] = [];
  const add = (code: string, field: string, message: string): void => {
    failures.push({ code, field, message, fixHint: message });
  };
  let warnings: IssueDiagnostic[] = [];
  try {
    const parsed = parseIssueBody(input.body, {
      title: input.title,
      ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
      ...(input.points === undefined ? {} : { points: input.points }),
    });
    const result = validateIssue(parsed.issue);
    if (parsed.issue.deferral !== undefined)
      add('deferred', 'defer', 'Issue is deferred; explicitly undefer it before starting work.');
    failures.push(...result.failures);
    warnings = issueWarnings(parsed.issue);
    if (!parsed.legacy && input.points !== undefined && parsed.issue.points !== input.points)
      add('points.sync', 'points', 'Reconcile canonical Points with the live native Points field.');
    if (!parsed.legacy && input.issueType !== undefined && parsed.issue.issueType !== input.issueType)
      add('type.sync', 'issueType', 'Reconcile the canonical Issue Type with the live native Issue Type.');
  } catch (error) {
    if (!(error instanceof IssueValidationError)) throw error;
    failures.push(...error.failures);
  }
  if (input.points === undefined)
    add('points', 'points', 'Set configured native Points before autonomous development.');
  if ((input.blockedBy?.length ?? 0) > 0)
    add('blocked', 'blockedBy', 'Resolve open native blockers before autonomous development.');
  if (input.trackingParent)
    add('tracking-parent', 'parent', 'Dispatch an executable sub-issue instead of the tracking parent.');
  return { failures, warnings, ready: failures.length === 0 };
}
