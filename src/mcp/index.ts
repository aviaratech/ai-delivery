import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { executeTool, type ExecutionContext } from '../dispatch.js';
import { setLogsSuppressed } from '../logger.js';
import { AI_DELIVERY_MCP_TOOLS, type AiDeliveryMcpToolName } from './tools.js';

export { AI_DELIVERY_MCP_CONTRACT_VERSION, AI_DELIVERY_MCP_TOOLS } from './tools.js';

export function createAiDeliveryMcpServer(context: ExecutionContext, activeCalls?: Set<Promise<unknown>>): McpServer {
  const server = new McpServer({ name: 'ai-delivery', version: '0.3.1' });
  const tools: readonly { name: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape> }[] =
    AI_DELIVERY_MCP_TOOLS;
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args, extra) => {
        const parsed = tool.inputSchema.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text' as const, text: `Invalid arguments for ${tool.name}.` }], isError: true };
        }
        try {
          const signal = context.signal === undefined ? extra.signal : AbortSignal.any([context.signal, extra.signal]);
          const pending = executeTool(tool.name as AiDeliveryMcpToolName, parsed.data, {
            ...context,
            signal,
          });
          activeCalls?.add(pending);
          let value: unknown;
          try {
            value = await pending;
          } finally {
            activeCalls?.delete(pending);
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
        } catch (error) {
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
