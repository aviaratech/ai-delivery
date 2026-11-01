import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test, vi } from 'vitest';
import * as repository from './github/repo.js';
import * as settings from './config/deliveryConfig.js';
import * as issues from './issue.js';
import { inertTarget, type PolicyState } from './fixtures/inertTarget.js';

type Fixture = ReturnType<typeof inertTarget>;
type Connection = Awaited<ReturnType<Fixture['connect']>>;

function assertRealContext() {
  assert.equal(vi.isMockFunction(settings.loadDeliverySettings), false);
  assert.equal(vi.isMockFunction(settings.loadDeliveryConfig), false);
  assert.equal(vi.isMockFunction(issues.loadDeliveryContext), false);
}

/** Extend only the fixture's synthetic GitHub timeline port; discovery and health stay real. */
for (const kind of ['tracked', 'edited'] satisfies PolicyState[]) {
  test(`public MCP omitted-repo fallback reaches actual origin discovery with ${kind} policy`, async ({ signal }) => {
    const descriptor = Object.getOwnPropertyDescriptor(InMemoryTransport.prototype, 'send');
    assert.ok(descriptor);
    assert.equal(typeof descriptor.value, 'function');
    const send = descriptor.value as InMemoryTransport['send'];
    const f = inertTarget(signal);
    // A spy delegates to the original resolver: it observes real protected system-Git origin probes.
    const origin = vi.spyOn(repository, 'resolveRepoFromRemote');
    const transport = vi.spyOn(InMemoryTransport.prototype, 'send');
    const delivered: Record<string, unknown>[] = [];
    transport.mockImplementation(function (this: InMemoryTransport, message, options) {
      if ('method' in message && message.method === 'tools/call' && message.params?.name === 'issue_info') {
        // Serialize the actual request sent to the paired transport, not an unrelated copy.
        const request = JSON.parse(JSON.stringify(message)) as typeof message;
        const args = request.params?.arguments as Record<string, unknown>;
        assert.deepEqual(args, { issueNumber: 17 });
        assert.equal(Object.hasOwn(args, 'repo'), false);
        delivered.push(args);
        return send.call(this, request, options);
      }
      return send.call(this, message, options);
    });
    let connection: Connection | undefined;
    try {
      f.policy(kind);
      assertRealContext();
      connection = await f.connect();
      // The delegating transport serializes this actual request and witnesses repo omission.
      const input: Record<string, unknown> = { issueNumber: 17, repo: undefined };
      const result = await connection.call('issue_info', input);
      assert.deepEqual(delivered, [{ issueNumber: 17 }]);
      assert.notEqual(result.response.isError, true, result.text);
      assert.equal(result.value!.issueNumber, 17);
      assert.equal(result.value!.points, 2);
      assert.deepEqual(origin.mock.calls, [[f.root, 'origin']]);
      assert.deepEqual(
        origin.mock.results.map(({ type, value }) => ({ type, value: value as unknown })),
        [{ type: 'return', value: { owner: 'example', repo: 'widget' } }],
      );
      assert.ok(f.calls.some((call) => call.name === 'issues.get'));
      f.assertInert();
    } finally {
      try {
        await f.dispose(connection);
      } finally {
        transport.mockRestore();
        origin.mockRestore();
      }
    }
  }, 5_000);
}
