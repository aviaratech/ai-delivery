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

const SERVER_INSTRUCTIONS =
  'Use issue_info with an explicit repo; follow repository policy for checks and authorization, and respect requested providers and read-only intent.';

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
          const pending = executeTool(tool.name as AiDeliveryMcpToolName, input, {
            ...context,
            signal,
            ...(verbose === true ? { verbose } : {}),
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
