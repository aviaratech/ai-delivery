import { renderDeliveryBoard, type DeliveryBoardResult } from './deliveryBoard.js';

/** Project transport output only; stored content and internal readbacks stay complete. */
export function projectToolOutput(command: string, value: unknown, verbose = false): unknown {
  if (command === 'delivery_board' && !verbose) return renderDeliveryBoard(value as DeliveryBoardResult);
  if (verbose || !command.startsWith('issue_')) return value;
  return compact(value);
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (['body', 'routing', 'conversion', 'bodyTransition'].includes(key)) return [];
      // Recovery inputs and diagnostics are actionable data, never presentation copies.
      if (['recovery', 'safeResume', 'warnings', 'failures', 'fields'].includes(key)) return [[key, item]];
      if (key === 'reviewRoute' && typeof item === 'object' && item !== null) {
        const route = item as Record<string, unknown>;
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(route).map(([field, detail]) => {
                if (
                  (field === 'author' || field === 'reviewer') &&
                  typeof detail === 'object' &&
                  detail !== null &&
                  'actorLogin' in detail
                )
                  return [field, { actorLogin: detail.actorLogin }];
                return [field, detail];
              }),
            ),
          ],
        ];
      }
      return [[key, compact(item)]];
    }),
  );
}
