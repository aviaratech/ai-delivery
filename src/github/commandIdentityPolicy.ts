import type { DeliveryConfig, DeliveryRole } from '../config/deliveryConfig.js';

export interface CommandIdentityPolicyEvaluation {
  error: null | string;
  normalizedCommandName: string;
  requiredRole: DeliveryRole | null;
  requiresExplicitIdentity: boolean;
}

const AUTHOR_COMMANDS = new Set([
  'cleanup',
  'close',
  'comment',
  'create',
  'develop',
  'finish',
  'start',
  'update',
  'pr:create',
  'pr:merge',
  'worktree',
  'worktree:create',
  'worktrees:cleanup',
  'pr:checkout',
]);
const REVIEWER_COMMANDS = new Set(['pr:review']);

export function evaluateCommandIdentityPolicy(input: {
  commandName: string;
  deliveryConfig: Pick<DeliveryConfig, 'roles'>;
  identity: null | string;
  personalAuth?: boolean;
}): CommandIdentityPolicyEvaluation {
  const normalizedCommandName = input.commandName.trim().toLowerCase();
  const requiredRole: DeliveryRole | null = REVIEWER_COMMANDS.has(normalizedCommandName)
    ? 'reviewer'
    : AUTHOR_COMMANDS.has(normalizedCommandName)
      ? 'author'
      : null;
  if (requiredRole === null) {
    return { error: null, normalizedCommandName, requiredRole, requiresExplicitIdentity: false };
  }
  const identity = input.identity?.trim().toLowerCase() ?? '';
  let error: string | null = null;
  if (!identity) {
    error = `Command "${normalizedCommandName}" requires an explicit ${requiredRole} identity.`;
  } else if (identity === input.deliveryConfig.roles[requiredRole].identity.toLowerCase()) {
    if (input.personalAuth === true && input.deliveryConfig.roles[requiredRole].authSource !== 'personal') {
      error = 'Personal-token override requires the explicit personal identity.';
    }
  } else if (identity === 'personal') {
    if (requiredRole !== 'author' || input.personalAuth !== true) {
      error = `Command "${normalizedCommandName}" requires its configured identity; personal-token override requires explicit author opt-in.`;
    }
  } else if (input.personalAuth === true) {
    error = 'Personal-token opt-in requires the explicit personal identity.';
  } else {
    error = `Command "${normalizedCommandName}" requires configured ${requiredRole} identity "${input.deliveryConfig.roles[requiredRole].identity}".`;
  }
  return { error, normalizedCommandName, requiredRole, requiresExplicitIdentity: true };
}
