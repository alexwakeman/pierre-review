// THE DRIVERS ON A REAL DAEMON AND A REAL MODEL (the `live` project; docs/SANDBOX.md § Agent drivers).
// Spends real usage, so every case is skipped unless LIMN_SANDBOX_LIVE names the provider:
//
//   CLAUDE_CODE_OAUTH_TOKEN=… LIMN_SANDBOX_LIVE=claude pnpm --filter @pierre-review/backend exec \
//     vitest run --project live src/sandbox/drivers/drivers.live.test.ts
//   LIMN_SANDBOX_LIVE=codex …   (Limn's own Codex sign-in, ~/.limn/codex/auth.json)
//
// Claude: a two-turn chat in plan mode (the second recalls the first and must NOT write), Start build,
// a build turn that writes. Codex: a chat turn, then the thread RESUMED in a new app-server. Both: the
// credential is injected at the proxy (the real token is in no sandbox file), and every resource carries
// `limn.test=1` and is removed. Image: LIMN_SANDBOX_TEST_IMAGE, else `limn-sandbox:dev`.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxAgentEvent } from '@pierre-review/shared';
import { proxyCredentialsFor } from '../proxy/credentials.js';
import { startEgress, type EgressSession } from '../proxy/egress.js';
import { createDockerRuntime } from '../runtime/docker.js';
import { startClaudeDriver } from './claude.js';
import { startCodexDriver } from './codex.js';
import type { SandboxAgentDriver, SandboxUsageRow } from './types.js';

const live = (process.env.LIMN_SANDBOX_LIVE ?? '').split(',');
const docker = process.env.SANDBOX_CLI || 'docker';
const daemon = spawnSync(docker, ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 20_000 }).stdout?.trim() === 'linux';
const IMAGE = process.env.LIMN_SANDBOX_TEST_IMAGE ?? 'limn-sandbox:dev';
const WORK = '/Users/limn-live/ws';

const instance = `test-${randomBytes(4).toString('hex')}`;
const rt = createDockerRuntime({ instance, extraLabels: { 'limn.test': '1' } });
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  expect(await rt.sweep([], { dryRun: true })).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
}, 120_000);

async function boot(provider: 'claude' | 'codex', env: NodeJS.ProcessEnv) {
  const owner = { sessionId: `t${randomBytes(4).toString('hex')}`, accountId: 1 };
  cleanups.push(() => rt.destroy(owner.sessionId));
  const net = await rt.createNetwork(owner);
  const egress: EgressSession = await startEgress({
    runtime: rt,
    owner,
    workspaceId: 0,
    image: IMAGE,
    network: net.name,
    provider,
    env,
    store: { list: async () => [], add: async (_a, _w, rule) => ({ ok: true, rule, added: true }) },
  });
  cleanups.push(async () => egress.close());
  expect(egress.credentialProblem).toBeNull();
  const volume = await rt.createVolume(owner, 'work');
  const box = await rt.startSandbox({
    ...owner,
    image: IMAGE,
    network: net.name,
    env: egress.sandboxEnv,
    mounts: [{ kind: 'volume', name: volume, target: WORK }],
    resources: { cpus: 2, memoryBytes: 2 * 1024 ** 3, pids: 512, diskBytes: 2 * 1024 ** 3 },
    workdir: WORK,
  });
  await rt.run(box.name, ['bash', '-c', `cd ${WORK} && git init -q && git config user.email a@b && git config user.name a && echo hi > README.md && git add . && git commit -qm init`]);
  return { owner, egress, box: box.name };
}

const sh = async (box: string, cmd: string): Promise<string> => String((await rt.run(box, ['bash', '-c', cmd])).stdout).trim();

/** The real secret appears in no file of the sandbox (checked by its tail, sent over stdin). */
async function secretInNoFile(box: string, secret: string): Promise<void> {
  const r = await rt.run(box, ['bash', '-c', 'read -r N; grep -rIl -F -- "$N" /home/agent /Users /tmp 2>/dev/null | wc -l'], { input: `${secret.slice(-24)}\n` });
  expect(String(r.stdout).trim()).toBe('0');
}

describe.skipIf(!daemon || !live.includes('claude'))('the Claude driver, live', () => {
  it('chat twice in plan mode, Start build, build', async () => {
    const { egress, box } = await boot('claude', process.env);
    const events: SandboxAgentEvent[] = [];
    const rows: SandboxUsageRow[] = [];
    const d: SandboxAgentDriver = await startClaudeDriver({
      runtime: rt,
      container: box,
      cwd: WORK,
      choice: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
      env: egress.sandboxEnv,
      systemPrompt: 'You are in a disposable test sandbox. Keep every answer to a few words.',
      maxTurns: 4,
      usage: { accountId: 1 },
      usageSink: { record: async (r) => void rows.push(r), noteClaudeRateLimit: () => {} },
      beforeTurn: () => egress.refreshCredentials(),
      onEvent: (e) => void events.push(e),
    });
    cleanups.push(() => d.close());

    const r1 = await d.send('Reply with the single word: alpha.');
    expect(r1.outcome).toBe('completed');
    expect(r1.text.toLowerCase()).toContain('alpha');
    const r2 = await d.send(`Use the Bash tool to run \`touch ${WORK}/plan.txt\`. Then tell me, in one word, the word you replied with before.`);
    expect(r2.text.toLowerCase()).toContain('alpha');
    expect(await sh(box, `test -e ${WORK}/plan.txt && echo yes || echo no`)).toBe('no');

    await d.startBuild();
    const r3 = await d.send(`Use the Bash tool to run \`echo built > ${WORK}/built.txt\`. Then reply: done.`);
    expect(r3).toMatchObject({ mode: 'build', outcome: 'completed' });
    expect(await sh(box, `cat ${WORK}/built.txt`)).toBe('built');

    expect(events.some((e) => e.type === 'text' && e.partial)).toBe(true);
    expect(events.some((e) => e.type === 'tool_call' && e.tool === 'Bash')).toBe(true);
    expect(rows.map((r) => r.feature)).toEqual(['story_plan', 'story_plan', 'story_build']);
    expect(rows.every((r) => r.costUsd > 0 && r.provider === 'claude')).toBe(true);
    console.log('[live claude]', JSON.stringify({ agentRef: Boolean(d.agentRef()), costs: rows.map((r) => r.costUsd), texts: [r1.text, r2.text, r3.text] }));

    const real = proxyCredentialsFor('claude', process.env).creds.anthropicOauth;
    if (real) await secretInNoFile(box, real);
  }, 300_000);
});

describe.skipIf(!daemon || !live.includes('codex'))('the Codex driver, live', () => {
  it('a chat turn, then the thread resumed in a new app-server', async () => {
    // The host's Codex sign-in is Limn's own home (the test project points LIMN_DATA_DIR at a temp dir).
    const env = { ...process.env, LIMN_DATA_DIR: process.env.LIMN_LIVE_DATA_DIR ?? join(homedir(), '.limn') };
    const { egress, box } = await boot('codex', env);
    const events: SandboxAgentEvent[] = [];
    const rows: SandboxUsageRow[] = [];
    const common = {
      runtime: rt,
      container: box,
      cwd: WORK,
      choice: { provider: 'codex' as const, model: 'gpt-6-luna', effort: 'low' as const },
      env: egress.sandboxEnv,
      codexAuthJson: egress.codexAuthJson,
      systemPrompt: 'You are in a disposable test sandbox. Keep every answer to a few words.',
      repoDirs: [WORK],
      usage: { accountId: 1 },
      usageSink: { record: async (r: SandboxUsageRow) => void rows.push(r) },
      beforeTurn: () => egress.refreshCredentials(),
      onEvent: (e: SandboxAgentEvent) => void events.push(e),
    };
    const d1 = await startCodexDriver(common);
    const r1 = await d1.send('Reply with the single word: alpha.');
    const thread = d1.agentRef();
    await d1.close();
    const errors = events.filter((e) => e.type === 'error');
    console.log('[live codex] turn 1', JSON.stringify({ outcome: r1.outcome, text: r1.text, errors, thread: Boolean(thread) }));
    // A ChatGPT account over its usage limit answers every model call 429: the turn fails, but the
    // protocol (handshake, thread, turn, resume) is still proven up to the model.
    const limited = errors.some((e) => e.type === 'error' && e.code === 'usage_limit');
    if (limited) console.warn('[live codex] the ChatGPT account is over its usage limit: a finished turn is NOT proven.');
    else {
      expect(r1.outcome).toBe('completed');
      expect(r1.text.toLowerCase()).toContain('alpha');
    }
    expect(errors.filter((e) => e.type === 'error' && e.code !== 'usage_limit')).toEqual([]);
    expect(r1.changedInChat).toEqual([]);

    const d2 = await startCodexDriver({ ...common, resumeRef: thread });
    cleanups.push(() => d2.close());
    expect(d2.agentRef()).toBe(thread);
    await d2.startBuild();
    const r2 = await d2.send(`Run \`echo built > ${WORK}/built.txt\` in the shell. Then reply with the word you replied with before, and nothing else.`);
    console.log('[live codex] resumed turn', JSON.stringify({ outcome: r2.outcome, text: r2.text }));
    if (limited) expect(r2.outcome).toBe('failed');
    else {
      expect(r2.outcome).toBe('completed');
      expect(r2.text.toLowerCase()).toContain('alpha');
      expect(await sh(box, `cat ${WORK}/built.txt`)).toBe('built');
    }
    expect(rows.every((r) => r.provider === 'codex' && r.costUsd === 0)).toBe(true);
    console.log('[live codex]', JSON.stringify({ tokens: rows.map((r) => [r.inputTokens, r.outputTokens]) }));
    const real = proxyCredentialsFor('codex', env).creds.chatgptAccess;
    if (real) await secretInNoFile(box, real);
  }, 300_000);
});
