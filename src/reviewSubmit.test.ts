import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, vi } from 'vitest';

import * as reviews from './review.js';
import { createDeliveryGitHubClients } from './github/client.js';
import { processSnapshot } from './verification.js';

vi.mock('node:child_process', { spy: true });

import { loadDeliverySettings, type LoadedDeliverySettings } from './config/deliveryConfig.js';

const sha = 'a'.repeat(40);
const tree = 'b'.repeat(40);
function verdict() {
  return {
    schemaVersion: 'ai-delivery.review-verdict@1',
    verdict: 'approve',
    summary: 'Reviewed the complete change independently.',
    issueNumber: 17,
    scope: { headSha: sha, headTree: tree, changedPaths: ['change.ts'] },
    verificationReproduced: ['Reproduced the focused regression; integration remains unexecuted.'],
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    effectiveModel: 'gpt-6-astra',
    effectiveEffort: 'xhigh',
    elapsedMs: 100,
    findings: [],
    readOnly: true,
  };
}
function parser(): (raw: unknown) => ReturnType<typeof verdict> {
  const parse: unknown = Reflect.get(reviews, 'parseReviewVerdict');
  assert.equal(typeof parse, 'function', 'The verdict boundary must validate before authentication.');
  return parse as (raw: unknown) => ReturnType<typeof verdict>;
}

test('verdict validation reports missing metadata and rejects scope expansion inputs', () => {
  const parse = parser();
  assert.deepEqual(parse(JSON.stringify(verdict())), verdict());
  for (const key of [
    'verdict',
    'scope',
    'verificationReproduced',
    'requestedModel',
    'effectiveModel',
    'requestedEffort',
    'effectiveEffort',
    'elapsedMs',
    'findings',
  ]) {
    const input: Record<string, unknown> = verdict();
    delete input[key];
    assert.throws(() => parse(input), new RegExp(key, 'u'));
  }
  for (const input of [
    { ...verdict(), elapsedMs: -1 },
    { ...verdict(), summary: '  ' },
    { ...verdict(), effectiveEffort: 'unknown' },
    { ...verdict(), unexpected: true },
    { ...verdict(), scope: { ...verdict().scope, changedPaths: ['change.ts', 'change.ts'] } },
  ])
    assert.throws(() => parse(input));
  assert.throws(() => parse('{'), /JSON/u);
});

function commandFixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-submit-cli-'));
  const pkg = join(root, 'package');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(pkg);
  cpSync(join(process.cwd(), 'dist'), join(pkg, 'dist'), { recursive: true });
  cpSync(join(process.cwd(), 'package.json'), join(pkg, 'package.json'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(pkg, 'node_modules'));
  chmodSync(join(pkg, 'dist', 'cli.js'), 0o755);
  symlinkSync(join(pkg, 'dist', 'cli.js'), join(bin, 'ai-delivery'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const key = join(root, 'fixture.pem');
  writeFileSync(
    key,
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
    { mode: 0o600 },
  );
  const settings = join(root, 'settings.json');
  const helperCalls = join(root, 'helper-calls.jsonl');
  const helperScenario = join(root, 'helper-scenario');
  const helper = join(bin, 'credential-helper');
  const profile = (identity: string, appId: number, installationId: number, provider: string) => ({
    authSource: 'app',
    identity,
    appId,
    installationId,
    actorLogin: `fixture-${provider === 'openai' ? 'gpt' : 'claude'}-reviewer[bot]`,
    provider,
    credentialSource: { type: 'command', argv: [helper, identity], encoding: 'base64', env: ['FIXTURE_HELPER_AUTH'] },
  });
  writeFileSync(
    settings,
    JSON.stringify({
      schemaVersion: 'ai-delivery.user@1',
      project: 1,
      checkoutRoots: [],
      roles: {
        author: { authSource: 'personal', identity: 'host-author', credentialEnv: { token: 'AUTHOR_TOKEN' } },
        reviewer: profile('gpt-reviewer', 101, 201, 'openai'),
      },
      reviewerProfiles: {
        'claude-reviewer': profile('claude-reviewer', 102, 202, 'anthropic'),
        'custom-checker': profile('custom-checker', 101, 201, 'openai'),
      },
      pointsField: 'Estimate',
      priorityField: 'Urgency',
      statusField: 'Flow',
      statuses: { blocked: 'Waiting', done: 'Shipped', inProgress: 'Active', todo: 'Queued' },
      issueTypes: ['Task'],
    }),
  );
  writeFileSync(
    helper,
    `#!${process.execPath}
const {readFileSync,appendFileSync}=require('node:fs');
appendFileSync(${JSON.stringify(helperCalls)},JSON.stringify({args:process.argv.slice(2),names:Object.keys(process.env)})+'\\n');
const scenario=readFileSync(${JSON.stringify(helperScenario)},'utf8');
if(scenario==='command-denied'){process.stderr.write('FICTIONAL_PRIVATE_HELPER_ERROR');process.exit(1);}
if(scenario==='command-malformed'){process.stdout.write('FICTIONAL_PRIVATE_HELPER_ERROR');process.exit(0);}
if(scenario==='command-overflow'){process.stdout.write('x'.repeat(70*1024));process.exit(0);}
if(scenario==='command-empty')process.exit(0);
if(scenario==='command-pem'){process.stdout.write(readFileSync(${JSON.stringify(key)},'utf8'));process.exit(0);}
process.stdout.write(readFileSync(${JSON.stringify(key)}).toString('base64')+'\\n');
`,
    { mode: 0o755 },
  );
  const input = join(root, 'verdict.json');
  const preload = join(root, 'transport.mjs');
  const history = join(root, 'history.json');
  const calls = join(root, 'calls.jsonl');
  function run(
    options: {
      provider?: 'gpt' | 'claude';
      verdict?: 'approve' | 'request-changes';
      scenario?: string;
      repeat?: boolean;
      patch?: Record<string, unknown>;
      identity?: string;
      doctor?: boolean;
    } = {},
  ) {
    const provider = options.provider ?? 'gpt';
    const id = provider === 'gpt' ? 101 : 102;
    const identity = options.identity ?? `${provider}-reviewer`;
    if (!options.repeat) {
      rmSync(history, { force: true });
      rmSync(calls, { force: true });
      rmSync(helperCalls, { force: true });
    }
    writeFileSync(helperScenario, options.scenario ?? 'normal');
    writeFileSync(
      input,
      ' \n' +
        JSON.stringify({
          ...verdict(),
          verdict: options.verdict ?? 'approve',
          requestedModel: provider === 'gpt' ? 'gpt-6-astra' : 'claude-opus-4-6',
          effectiveModel: provider === 'gpt' ? 'gpt-6-astra' : 'claude-opus-4-6',
          ...options.patch,
        }) +
        '\n',
    );
    writeFileSync(
      preload,
      `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syntheticDiscoveryClients } from ${JSON.stringify(pathToFileURL(join(pkg, 'dist', 'fixtures', 'discovery.js')).href)};
const scenario=${JSON.stringify(options.scenario ?? 'normal')};
const historyPath=${JSON.stringify(history)},calls=${JSON.stringify(calls)};
const reviews=existsSync(historyPath)?JSON.parse(readFileSync(historyPath,'utf8')):[];
let reads=0;
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,init={})=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 const method=init.method??'GET';
 const body=typeof init.body==='string'?JSON.parse(init.body):{};
 appendFileSync(calls,JSON.stringify({path:url.pathname,method,event:body.event})+'\\n');
 if(url.hostname!=='api.github.com')throw new Error('Unexpected fixture destination');
 if(url.pathname==='/graphql'){
  const query=body.query;
  if(query.includes('DeliveryClosingIssues'))return response({data:{repository:{nameWithOwner:'example/widget',pullRequest:{number:19,closingIssuesReferences:{nodes:[{number:17,repository:{nameWithOwner:'example/widget'}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}});
  if(query.includes('DeliveryReviewDecision'))return response({data:{repository:{pullRequest:{headRefOid:'${sha}',reviewDecision:scenario==='still-required'?'REVIEW_REQUIRED':reviews.at(-1)?.state==='CHANGES_REQUESTED'?'CHANGES_REQUESTED':'APPROVED'}}}});
  if(query.includes('DeliveryReviewAccess'))return response({data:{repository:{pullRequest:{reviews:{nodes:reviews.map(r=>({fullDatabaseId:r.id,author:{login:r.user.login},authorCanPushToRepository:true,commit:{oid:r.commit_id},state:r.state}))}}}}});
  return response({data:await syntheticDiscoveryClients().graphql(query,body.variables)});
 }
 if(url.pathname==='/user')return response({id:42,login:'fixture-author',type:'User'});
 if(url.pathname.includes('/access_tokens'))return response({token:'ghs_fixture_${provider}',expires_at:'2999-01-01T00:00:00Z',permissions:{contents:'read',pull_requests:'write'}});
 if(url.pathname==='/app')return response({id:scenario==='foreign-app'?999:${id},slug:scenario==='wrong-actor'?'other-app':'fixture-${provider}-reviewer'});
 if(decodeURIComponent(url.pathname).endsWith('/git/ref/heads/issue/17'))return response({ref:'refs/heads/issue/17',object:{type:'commit',sha:scenario==='head-moved'?'${'f'.repeat(40)}':'${sha}'}});
 if(url.pathname.endsWith('/git/commits/${sha}'))return response({sha:'${sha}',tree:{sha:'${tree}'}});
 if(url.pathname.endsWith('/pulls/19/files'))return response([{filename:scenario==='scope-mismatch'?'other.ts':'change.ts'}]);
 if(url.pathname.endsWith('/pulls/19')){
  reads++;
  const moved=scenario==='head-moved'||scenario==='mid-head-moved'&&reads>=3||scenario==='post-head-moved'&&reviews.length>0;
  return response({number:19,changed_files:1,state:'open',merged:false,draft:false,user:{login:scenario==='self-review'?'fixture-${provider}-reviewer[bot]':'fixture-author'},head:{sha:moved?'${'f'.repeat(40)}':'${sha}',ref:'issue/17',repo:{full_name:'example/widget'}},base:{sha:'${'c'.repeat(40)}',ref:'main',repo:{full_name:'example/widget'}}});
 }
 if(url.pathname.endsWith('/pulls/19/reviews')&&method==='GET')return response(reviews);
 if(url.pathname.endsWith('/pulls/19/reviews')&&method==='POST'){
  const review={id:41,state:body.event==='APPROVE'?'APPROVED':'CHANGES_REQUESTED',commit_id:body.commit_id,user:{login:'fixture-${provider}-reviewer[bot]'},html_url:'https://github.com/example/widget/pull/19#pullrequestreview-41',body:body.body};
  reviews.push(review);writeFileSync(historyPath,JSON.stringify(reviews));
  if(scenario==='ack-lost')throw new Error('Fictional acknowledgement loss');
  return response(review,201);
 }
 if(url.pathname.endsWith('/pulls/19/reviews/41')){
  if(scenario==='readback-failed')throw new Error('Fictional readback loss');
  return response(reviews[0]);
 }
 throw new Error('Unexpected fixture request '+method+' '+url.pathname);
};
`,
    );
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      PATH: bin,
      AI_DELIVERY_CONFIG: settings,
      AUTHOR_TOKEN: 'fixture_author',
      LOGNAME: 'fixture-user',
      FIXTURE_HELPER_AUTH: 'fixture_helper_auth',
      UNUSED_APP_KEY: 'FICTIONAL_UNUSED_PRIVATE_KEY',
      SELECTED_KEY: readFileSync(key, 'utf8'),
      GH_PRIVATE_KEY_GPT_REVIEWER: readFileSync(key, 'utf8'),
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    };
    const result = spawnSync(
      'ai-delivery',
      options.doctor
        ? ['review', 'doctor', '--identity', identity]
        : [
            'review',
            'submit',
            '--pr',
            '19',
            '--head',
            sha,
            '--identity',
            identity,
            '--verdict',
            input,
            '--repo',
            'example/widget',
          ],
      { cwd: root, env, encoding: 'utf8', maxBuffer: 256 * 1024 },
    );
    const requests = existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { path: string; method: string; event?: string })
      : [];
    const resolutions = existsSync(helperCalls)
      ? readFileSync(helperCalls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { names: string[]; args: string[] })
      : [];
    return {
      ...result,
      requests,
      resolutions,
      posts: requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reviews')),
    };
  }
  return {
    run,
    root,
    input,
    history,
    settings,
    key,
    helper,
    setSource(source: unknown) {
      const data = JSON.parse(readFileSync(settings, 'utf8')) as {
        roles: { reviewer: { credentialSource?: unknown } };
      };
      if (source === undefined) delete data.roles.reviewer.credentialSource;
      else data.roles.reviewer.credentialSource = source;
      writeFileSync(settings, JSON.stringify(data));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test(
  'stable package bin submits both provider verdicts with clean PATH and refreshes counted status',
  { tags: ['release'] },
  () => {
    const fixture = commandFixture();
    try {
      for (const provider of ['gpt', 'claude'] as const)
        for (const decision of ['approve', 'request-changes'] as const) {
          const result = fixture.run({ provider, verdict: decision });
          assert.equal(result.status, 0, result.stderr);
          const receipt = JSON.parse(result.stdout) as {
            state: string;
            login: string;
            requiredReview: { status: string };
            artifact: { requestedModel: string; reviewerIdentity: string; verdictFileSha256: string; checks: string[] };
          };
          assert.equal(receipt.state, decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED');
          assert.equal(receipt.login, `fixture-${provider}-reviewer[bot]`);
          assert.equal(receipt.artifact.reviewerIdentity, `${provider}-reviewer`);
          assert.equal(receipt.requiredReview.status, decision === 'approve' ? 'satisfied' : 'changes-requested');
          assert.equal(result.posts.length, 1);
          assert.equal(result.resolutions.length, 1);
          assert.deepEqual(result.resolutions[0]!.args, [`${provider}-reviewer`]);
          assert.equal(result.resolutions[0]!.names.includes('AUTHOR_TOKEN'), false);
          assert.equal(result.resolutions[0]!.names.includes('UNUSED_APP_KEY'), false);
          assert.equal(result.resolutions[0]!.names.includes('NODE_OPTIONS'), false);
          assert.equal(
            receipt.artifact.verdictFileSha256,
            'sha256:' + createHash('sha256').update(readFileSync(fixture.input)).digest('hex'),
          );
          const body = (JSON.parse(readFileSync(fixture.history, 'utf8')) as { body: string }[])[0]!.body;
          for (const text of [
            'Verdict-file SHA256: ' + receipt.artifact.verdictFileSha256,
            'Requested model/effort:',
            'Effective model/effort:',
            'Elapsed milliseconds: 100',
            'Findings: none',
          ])
            assert.ok(body.includes(text), text);
          assert.equal(body.includes('PRIVATE KEY'), false);
          assert.equal(result.posts[0]!.event, decision === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES');
          const retry = fixture.run({ provider, verdict: decision, repeat: true });
          assert.equal(retry.status, 0, retry.stderr);
          assert.equal(retry.posts.length, 1, 'Retry must reuse the original review without a second POST.');
        }
      const inherited = fixture.run({ scenario: 'still-required' });
      assert.equal(inherited.status, 0, inherited.stderr);
      assert.equal(
        (JSON.parse(inherited.stdout) as { requiredReview: { status: string } }).requiredReview.status,
        'still-required',
      );
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  'actual command refuses stale scope/head/actor and invalid metadata without a review mutation',
  { tags: ['release'] },
  () => {
    const fixture = commandFixture();
    try {
      for (const scenario of [
        'head-moved',
        'mid-head-moved',
        'scope-mismatch',
        'foreign-app',
        'wrong-actor',
        'self-review',
      ]) {
        const result = fixture.run({ scenario });
        assert.notEqual(result.status, 0, scenario);
        assert.equal(result.posts.length, 0, scenario);
        if (['head-moved', 'mid-head-moved', 'scope-mismatch'].includes(scenario) && scenario !== 'mid-head-moved')
          assert.equal(result.resolutions.length, 0, scenario);
      }
      for (const options of [
        { identity: 'builder' },
        { identity: 'personal' },
        { identity: 'claude-reviewer' },
        { patch: { effectiveModel: 'claude-opus-4-6' } },
        { patch: { elapsedMs: -1 } },
        { patch: { requestedEffort: '' } },
      ]) {
        const result = fixture.run(options);
        assert.notEqual(result.status, 0);
        assert.equal(result.requests.length, 0, 'Malformed verdict/identity must fail before any authentication.');
        assert.equal(result.resolutions.length, 0);
      }
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  'actual command preserves known or ambiguous mutation and reconciles acknowledgement loss',
  { tags: ['release'] },
  () => {
    const fixture = commandFixture();
    try {
      for (const scenario of ['post-head-moved', 'readback-failed', 'ack-lost']) {
        const result = fixture.run({ scenario });
        assert.notEqual(result.status, 0, result.stderr);
        const pending = JSON.parse(result.stdout) as {
          status: string;
          submission: { prNumber: number; githubReviewId?: number };
        };
        assert.equal(pending.status, 'submission-unverified');
        assert.equal(pending.submission.prNumber, 19);
        assert.equal(result.posts.length, 1);
        if (scenario !== 'ack-lost') assert.equal(pending.submission.githubReviewId, 41);
        if (scenario === 'ack-lost') {
          const retry = fixture.run({ repeat: true });
          assert.equal(retry.status, 0, retry.stderr);
          assert.equal(retry.posts.length, 1);
        }
      }
    } finally {
      fixture.cleanup();
    }
  },
);

test('explicit provider binding supports consumer names and rejects mismatched models or heads before auth', () => {
  const build: unknown = Reflect.get(reviews, 'buildReviewArtifact');
  assert.equal(typeof build, 'function');
  const create = build as (input: unknown) => { reviewerIdentity: string; verdict: string };
  const input = {
    verdictFileSha256: 'sha256:' + 'd'.repeat(64),
    verdict: parser()(verdict()),
    identity: 'custom-checker',
    provider: 'openai',
    expectedHead: sha,
    prNumber: 19,
    authorIdentity: 'host-author',
  };
  assert.equal(create(input).reviewerIdentity, 'custom-checker');
  for (const patch of [
    { identity: 'host-author' },
    { provider: 'anthropic' },
    { expectedHead: 'c'.repeat(40) },
    { verdict: { ...verdict(), effectiveModel: 'claude-opus-4-6' } },
    { verdict: { ...verdict(), summary: 'a'.repeat(30000) } },
  ])
    assert.throws(() => create({ ...input, ...patch }));
  assert.equal(
    create({
      ...input,
      provider: 'anthropic',
      verdict: {
        ...verdict(),
        verdict: 'request-changes',
        requestedModel: 'claude-opus-4-6',
        effectiveModel: 'claude-opus-4-6',
        requestedEffort: 'high',
        effectiveEffort: 'high',
      },
    }).verdict,
    'request-changes',
  );
});

test('selected profile environment preserves machine selectors and excludes unused keys without secret fetch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-source-settings-'));
  const config = join(root, 'settings.json');
  const profile = (identity: string, id: number) => ({
    authSource: 'app',
    identity,
    appId: id,
    installationId: id + 100,
    actorLogin: `fixture-${identity}[bot]`,
    provider: 'openai',
    credentialSource: { type: 'env', variable: identity === 'default-checker' ? 'DEFAULT_KEY' : 'SELECTED_KEY' },
  });
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 'ai-delivery.user@1',
      project: 1,
      checkoutRoots: [],
      roles: {
        author: { authSource: 'personal', identity: 'host-author', credentialEnv: { token: 'GH_TOKEN' } },
        reviewer: profile('default-checker', 101),
      },
      reviewerProfiles: { 'custom-checker': profile('custom-checker', 102) },
    }),
  );
  vi.stubEnv('AI_DELIVERY_CONFIG', config);
  const inherited = {
    AI_DELIVERY_CONFIG: config,
    HOME: root,
    PATH: '/fixture/bin',
    GH_HOST: 'github.com',
    GH_CONFIG_DIR: root,
    UNUSED_KEY: 'FICTIONAL_UNUSED_KEY',
    DEFAULT_KEY: 'FICTIONAL_DEFAULT_KEY',
    SELECTED_KEY: 'FICTIONAL_SELECTED_KEY',
    NODE_OPTIONS: '--invalid',
  };
  try {
    const selected = (await Reflect.apply(loadDeliverySettings, undefined, [
      undefined,
      { reviewerIdentity: 'custom-checker', env: inherited, prepareEnvironment: true },
    ])) as LoadedDeliverySettings & { environment: NodeJS.ProcessEnv };
    assert.equal(selected.roles.reviewer.identity, 'custom-checker');
    for (const name of ['HOME', 'PATH', 'GH_HOST', 'GH_CONFIG_DIR'] as const)
      assert.equal(selected.environment[name], inherited[name]);
    assert.equal(selected.environment.SELECTED_KEY, 'FICTIONAL_SELECTED_KEY');
    for (const name of ['UNUSED_KEY', 'DEFAULT_KEY', 'NODE_OPTIONS'])
      assert.equal(selected.environment[name], undefined);
    assert.equal(inherited.UNUSED_KEY, 'FICTIONAL_UNUSED_KEY');
    const changed = JSON.parse(readFileSync(config, 'utf8')) as {
      roles: { reviewer: { credentialSource: { variable: string } } };
    };
    changed.roles.reviewer.credentialSource.variable = 'NEW_DEFAULT_KEY';
    writeFileSync(config, JSON.stringify(changed));
    const next = await loadDeliverySettings(undefined, {
      reviewerIdentity: 'custom-checker',
      env: inherited,
      prepareEnvironment: true,
    });
    assert.notEqual(
      next.sourceDigest,
      selected.sourceDigest,
      'The source digest must bind unselected key references too.',
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'command denial, malformed output and overflow refuse without output leakage or writes',
  { tags: ['release'] },
  () => {
    const fixture = commandFixture();
    try {
      for (const scenario of ['command-denied', 'command-malformed', 'command-overflow', 'command-empty']) {
        const result = fixture.run({ scenario });
        assert.notEqual(result.status, 0);
        assert.equal(result.posts.length, 0);
        assert.equal(result.resolutions.length, 1);
        assert.equal((result.stdout + result.stderr).includes('FICTIONAL_PRIVATE_HELPER_ERROR'), false);
        assert.equal((result.stdout + result.stderr).includes('fixture_helper_auth'), false);
      }
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  'read-only doctor uses the selected source and actual App actor outside Git without review or project mutations',
  { tags: ['release'] },
  () => {
    const fixture = commandFixture();
    try {
      const result = fixture.run({ identity: 'custom-checker', doctor: true });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout) as { identity: string; actorLogin: string };
      assert.equal(output.identity, 'custom-checker');
      assert.equal(output.actorLogin, 'fixture-gpt-reviewer[bot]');
      assert.equal(result.resolutions.length, 1);
      assert.deepEqual(result.resolutions[0]!.args, ['custom-checker']);
      assert.equal(
        result.requests.some((r) => r.path === '/app'),
        true,
      );
      assert.equal(
        result.requests.every((r) => r.path === '/app' || r.path.includes('/access_tokens')),
        true,
      );
      assert.equal(result.posts.length, 0);
      const submit = fixture.run({ identity: 'custom-checker' });
      assert.equal(submit.status, 0, submit.stderr);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  'credential process observation excludes ambient credentials and executable injection selectors',
  { tags: ['release'] },
  async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let observedEnv: NodeJS.ProcessEnv | undefined;
    vi.mocked(spawnSync).mockImplementationOnce((command, args, options) => {
      // Node may add NODE_V8_COVERAGE to this object while normalizing the spawn.
      observedEnv = { ...options?.env };
      return actual.spawnSync(command, args, options);
    });
    vi.stubEnv('GH_PRIVATE_KEY_UNSELECTED', 'FICTIONAL_UNUSED_PRIVATE_KEY');
    vi.stubEnv('AUTHOR_TOKEN', 'FICTIONAL_AUTHOR_TOKEN');
    try {
      const calls = vi.mocked(spawnSync).mock.calls.length;
      assert.ok(processSnapshot().has(process.pid));
      const observed = vi.mocked(spawnSync).mock.calls.slice(calls);
      assert.equal(observed.length, 1);
      assert.deepEqual(observedEnv, { LC_ALL: 'C' });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test(
  'selected env default, explicit env, protected file and command PEM all use the same stable bin',
  { tags: ['release'] },
  () => {
    const fixture = commandFixture();
    try {
      for (const source of [
        undefined,
        { type: 'env', variable: 'SELECTED_KEY' },
        { type: 'file', path: fixture.key },
        { type: 'command', argv: [fixture.helper, 'gpt-reviewer'], encoding: 'pem' },
      ]) {
        fixture.setSource(source);
        const result = fixture.run({
          scenario: typeof source === 'object' && source.type === 'command' ? 'command-pem' : 'normal',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.posts.length, 1);
        assert.equal(result.resolutions.length, typeof source === 'object' && source.type === 'command' ? 1 : 0);
      }
      fixture.setSource({ type: 'file', path: fixture.key });
      chmodSync(fixture.key, 0o644);
      const refused = fixture.run();
      assert.notEqual(refused.status, 0);
      assert.equal(refused.posts.length, 0);
      assert.match(refused.stderr, /0600/u);
      chmodSync(fixture.key, 0o600);
      const link = join(fixture.root, 'linked-key.pem');
      symlinkSync(fixture.key, link);
      fixture.setSource({ type: 'file', path: link });
      const symlink = fixture.run();
      assert.notEqual(symlink.status, 0);
      assert.equal(symlink.posts.length, 0);
      fixture.setSource({ type: 'command', argv: [join(fixture.root, 'missing-helper')] });
      const missing = fixture.run();
      assert.notEqual(missing.status, 0);
      assert.equal(missing.posts.length, 0);
      assert.equal(missing.resolutions.length, 0, 'An available env key must not become a fallback.');
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  'credential cancellation and response timeout await owned helper and descendant absence',
  { tags: ['release'] },
  async () => {
    const fixture = commandFixture();
    const pidFile = join(fixture.root, 'owned-pids.json');
    const helper = join(fixture.root, 'blocking-helper.cjs');
    writeFileSync(
      helper,
      `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`,
    );
    fixture.setSource({ type: 'command', argv: [process.execPath, helper] });
    vi.stubEnv('AI_DELIVERY_CONFIG', fixture.settings);
    try {
      for (const cancel of [true, false]) {
        rmSync(pidFile, { force: true });
        const settings = await loadDeliverySettings(undefined, {
          reviewerIdentity: 'gpt-reviewer',
          prepareEnvironment: true,
          env: {
            AI_DELIVERY_CONFIG: fixture.settings,
            HOME: fixture.root,
            PATH: '/usr/bin:/bin',
            AUTHOR_TOKEN: 'fixture_author',
            LOGNAME: 'fixture-user',
          },
        });
        const controller = new AbortController();
        const pending = createDeliveryGitHubClients({
          config: settings,
          identity: 'gpt-reviewer',
          role: 'reviewer',
          env: settings.environment!,
          signal: controller.signal,
        });
        const rejected = assert.rejects(pending, cancel ? /cancelled/u : /timed out/u);
        while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
        if (cancel) {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          controller.abort();
        }
        await rejected;
        const snapshot = processSnapshot();
        for (const pid of JSON.parse(readFileSync(pidFile, 'utf8')) as number[])
          assert.ok(!snapshot.has(pid) || snapshot.get(pid)!.status.startsWith('Z'), String(pid));
      }
    } finally {
      vi.unstubAllEnvs();
      fixture.cleanup();
    }
  },
);

test('ambiguous or reserved reviewer profiles fail closed before source selection', { tags: ['release'] }, async () => {
  const fixture = commandFixture();
  const original = readFileSync(fixture.settings, 'utf8');
  try {
    for (const identity of ['gpt-reviewer', 'personal-checker']) {
      const input = JSON.parse(original) as {
        roles: { reviewer: Record<string, unknown> };
        reviewerProfiles: Record<string, unknown>;
      };
      input.reviewerProfiles[identity] = { ...input.roles.reviewer, identity };
      writeFileSync(fixture.settings, JSON.stringify(input));
      await assert.rejects(
        loadDeliverySettings(undefined, { env: { AI_DELIVERY_CONFIG: fixture.settings } }),
        /distinct|personal|ambiguous/iu,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test.each(['unselected-profile-key', 'implicit-author-selector'] as const)(
  'credential reference collisions refuse before helper launch: %s',
  { tags: ['release'] },
  (collision) => {
    const fixture = commandFixture();
    try {
      const input = JSON.parse(readFileSync(fixture.settings, 'utf8')) as {
        roles: { author: { credentialEnv: { token: string } }; reviewer: Record<string, unknown> };
        reviewerProfiles: Record<string, unknown>;
      };
      if (collision === 'unselected-profile-key') {
        input.reviewerProfiles['other-key'] = {
          ...input.roles.reviewer,
          identity: 'other-key',
          credentialSource: { type: 'env', variable: 'UNUSED_APP_KEY' },
        };
        input.roles.reviewer.credentialSource = {
          type: 'command',
          argv: [fixture.helper, 'gpt-reviewer'],
          encoding: 'base64',
          env: ['UNUSED_APP_KEY'],
        };
      } else input.roles.author.credentialEnv.token = 'LOGNAME';
      writeFileSync(fixture.settings, JSON.stringify(input));
      const result = fixture.run({ doctor: true });
      assert.notEqual(result.status, 0);
      assert.equal(result.resolutions.length, 0);
      assert.equal(result.requests.length, 0);
      assert.equal((result.stdout + result.stderr).includes('FICTIONAL_UNUSED_PRIVATE_KEY'), false);
    } finally {
      fixture.cleanup();
    }
  },
);

test('verdict scope preserves valid Git filenames with edge whitespace', async () => {
  const paths = [' change.ts '];
  const parsed = reviews.parseReviewVerdict({ ...verdict(), scope: { ...verdict().scope, changedPaths: paths } });
  assert.deepEqual(parsed.scope.changedPaths, paths);
  const artifact = reviews.buildReviewArtifact({
    verdict: parsed,
    verdictFileSha256: 'sha256:' + 'd'.repeat(64),
    identity: 'custom-checker',
    provider: 'openai',
    authorIdentity: 'host-author',
    expectedHead: sha,
    prNumber: 19,
  });
  const context = {
    config: { repository: 'example/widget' },
    repo: { owner: 'example', repo: 'widget' },
    clients: {
      rest: {
        pulls: {
          get: async () => ({
            data: {
              number: 19,
              state: 'open',
              head: { sha, repo: { full_name: 'example/widget' } },
              base: { repo: { full_name: 'example/widget' } },
              changed_files: 1,
            },
          }),
          listFiles: async () => ({ data: paths.map((filename) => ({ filename })) }),
        },
        git: { getCommit: async () => ({ data: { sha, tree: { sha: tree } } }) },
      },
    },
  } as unknown as Parameters<typeof reviews.validateReviewTarget>[0];
  await reviews.validateReviewTarget(context, artifact, 19);
});
