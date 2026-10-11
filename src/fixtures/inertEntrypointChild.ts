import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mock } from 'node:test';
import { entrypointClients, type EntrypointRequest } from './inertEntrypoints.js';

// Trusted fixture driver, compiled outside the consumer; one process per independent negative observation.
const request = JSON.parse(readFileSync(process.env.AI_DELIVERY_ENTRYPOINT_REQUEST!, 'utf8')) as EntrypointRequest;
const ports = entrypointClients(request.head);
// Register before any configuration/client import cycle. Do not import the original client first.
mock.module(new URL('../github/client.js', import.meta.url), {
  exports: {
    createDeliveryGitHubClients: ports.create,
    retainMachineAuthorForConfiguration: () => {},
  },
});
let output = '';
if (request.mode === 'mcp') {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createAiDeliveryMcpServer } = await import('../mcp/index.js');
  const server = createAiDeliveryMcpServer({ repoRoot: request.root });
  const client = new Client({ name: 'fresh-inert-entrypoint', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    const response = await client.callTool({
      name: 'issue_info',
      arguments: { repo: 'example/widget', issueNumber: 17 },
    });
    assert.notEqual(response.isError, true);
    output = (response.content as { text: string }[])[0]!.text;
  } finally {
    try {
      await client.close();
    } finally {
      await server.close();
    }
  }
} else if (request.mode === 'direct') {
  const { executeTool } = await import('../agent.js');
  output = JSON.stringify(
    await executeTool('issue_info', { repo: 'example/widget', issueNumber: 17 }, { repoRoot: request.root }),
  );
}
if (request.mode === 'direct' || request.mode === 'mcp') process.stdout.write(`${output}\n`);
// CLI mode is a native --import preload: Node executes the actual CLI as its main file after this module.
process.once('beforeExit', () => {
  assert.equal(process.exitCode ?? 0, 0, 'The real entrypoint must complete successfully');
  writeFileSync(
    request.report,
    JSON.stringify({
      schemaVersion: 'ai-delivery.fresh-entrypoint@1',
      pid: process.pid,
      mode: request.mode,
      args: request.args,
      calls: ports.calls,
      interpreter: { version: process.version, executable: process.execPath },
      fixtureDriver: import.meta.url,
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  mock.restoreAll();
});
