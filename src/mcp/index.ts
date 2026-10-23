import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { executeTool, type ExecutionContext } from '../dispatch.js';
import { setLogsSuppressed } from '../logger.js';
import { PACKAGE_VERSION } from '../version.js';
import { JOURNAL_SCHEMA_METADATA, missingJournalFields } from '../issueJournal.js';
import { getIncompleteIssueUpdate } from '../issue.js';
import { projectToolOutput } from '../toolOutput.js';
import { AI_DELIVERY_MCP_TOOLS, type AiDeliveryMcpToolName } from './tools.js';

export { AI_DELIVERY_MCP_CONTRACT_VERSION, AI_DELIVERY_MCP_TOOLS } from './tools.js';

const SERVER_INSTRUCTIONS = [
  'Use these ai-delivery GitHub issue and pull request tools for ordinary requests, including "Use the ai-delivery MCP issue_info tool to read owner/name issue N".',
  'Carry the repository named by the user into the repo argument (owner/name). Ordinary remote issue/PR tools work outside Git with an explicit repo; do not move into a checkout to read an issue.',
  'In Claude Code, when bare and plugin-qualified ai-delivery tools coexist, discover the installed plugin provider and inspect its schema before calling. The observed plugin example is mcp__plugin_ai-delivery_ai-delivery__issue_info with {"repo":"example/widget","issueNumber":17}; use the requested repository and issue instead. This Claude namespace is not a universal tool name for other hosts.',
  'A different issue_info accepting issueNumber/cached but no repo cannot receive that repository argument. Do not add unsupported fields or select a provider by name similarity alone. Honor an explicitly requested provider; if it is unavailable or incompatible, report that limitation rather than silently substituting.',
  'Preserve read-only and MCP-only intent: do not create/update/start, use another GitHub provider or fall back to a CLI for such a read. Do not alter registrations, permissions, actors, credentials or host settings to make it work.',
  'Retained local runtime, transition and investigation modes keep their separate checkout and authority requirements.',
].join('\n');

export function createAiDeliveryMcpServer(context: ExecutionContext, activeCalls?: Set<Promise<unknown>>): McpServer {
  const server = new McpServer(
    { name: 'ai-delivery', version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const tools: readonly { name: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape> }[] =
    AI_DELIVERY_MCP_TOOLS;
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The SDK must leave journal kind refinements to the handler so missing
        // conditional fields receive a safe, actionable contract refusal. Unknown
        // property names stay private through a schema-local error message.
        inputSchema:
          tool.name === 'issue_comment'
            ? z
                .strictObject(tool.inputSchema.shape, {
                  error: 'Invalid journal object. Provide only the advertised fields.',
                })
                .partial()
                .meta(JOURNAL_SCHEMA_METADATA)
            : tool.inputSchema,
      },
      async (args, extra) => {
        const parsed = tool.inputSchema.safeParse(args);
        if (!parsed.success) {
          const missing = tool.name === 'issue_comment' ? missingJournalFields(args) : [];
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid arguments for ${tool.name}.${missing.length ? ` Missing required fields: ${missing.join(', ')}. Provide every missing field.` : tool.name === 'issue_comment' ? ` ${tool.description}` : ''}`,
              },
            ],
            isError: true,
          };
        }
        try {
          const signal = context.signal === undefined ? extra.signal : AbortSignal.any([context.signal, extra.signal]);
          const { verbose, ...input } = parsed.data;
          const progressToken = extra._meta?.progressToken;
          let observations = 0;
          const queueProgress: ExecutionContext['queueProgress'] =
            tool.name !== 'issue_pr_merge_queue_run' || progressToken === undefined
              ? undefined
              : async (progress) =>
                  extra.sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: ++observations,
                      message: `Observation ${observations}: ${progress.completed} entries complete, ${progress.remaining} remaining. ${progress.reason}`,
                    },
                  });
          const pending = executeTool(tool.name as AiDeliveryMcpToolName, input, {
            ...context,
            signal,
            ...(queueProgress === undefined ? {} : { queueProgress }),
          });
          activeCalls?.add(pending);
          let value: unknown;
          try {
            value = await pending;
          } finally {
            activeCalls?.delete(pending);
          }
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(projectToolOutput(tool.name, value, verbose === true)) },
            ],
          };
        } catch (error) {
          const incomplete = getIncompleteIssueUpdate(error);
          if (incomplete !== undefined)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    projectToolOutput(tool.name, incomplete, 'verbose' in args && args.verbose === true),
                  ),
                },
              ],
              isError: true,
            };
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}

export async function serveAiDeliveryMcp(context: ExecutionContext): Promise<void> {
  setLogsSuppressed(true);
  const shutdown = new AbortController();
  const activeCalls = new Set<Promise<unknown>>();
  const server = createAiDeliveryMcpServer({ ...context, signal: shutdown.signal }, activeCalls);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      shutdown.abort();
      await Promise.allSettled(activeCalls);
      await server.close();
      process.exit(0);
    })();
    return closing;
  };
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write('ai-delivery MCP server started\n');
  await new Promise<void>(() => {});
}
