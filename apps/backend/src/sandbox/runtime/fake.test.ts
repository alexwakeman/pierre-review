import { describe, expect, it } from 'vitest';
import { createFakeRuntime } from './fake.js';
import { listRunningSandboxes, sweepSandboxesAtBoot, sweepSandboxesNow, sweepSettled } from './index.js';
import { DEFAULT_RESOURCES } from './types.js';

const owner = { sessionId: 's1', accountId: 1 };

describe('fake runtime', () => {
  it('records calls, replays an interactive stream, and keeps copied files', async () => {
    const fake = createFakeRuntime();
    const net = await fake.createNetwork(owner);
    const box = await fake.startSandbox({ ...owner, image: 'i', network: net.name, env: {}, mounts: [], resources: DEFAULT_RESOURCES, workdir: '/w' });
    // A recorded stream replayed turn by turn: one output line per input line.
    fake.onExec('claude -p', async (ctx) => {
      for await (const line of ctx.stdin) ctx.stdout(`${JSON.stringify({ type: 'result', echo: JSON.parse(line).n })}\n`);
      return 0;
    });
    const h = fake.exec(box.name, ['claude', '-p', '--verbose'], { interactive: true });
    h.write('{"n":1}\n{"n":2}\n');
    h.end();
    let out = '';
    for await (const ev of h.events) if (ev.type === 'stdout') out += ev.data.toString();
    expect(out.trim().split('\n').map((l) => JSON.parse(l).echo)).toEqual([1, 2]);
    expect((await h.done).code).toBe(0);

    const missing = await fake.run(box.name, ['nope']);
    expect(missing.code).toBe(127);

    await fake.copyIn(box.name, [{ path: '/w/TICKET.md', content: '# T' }]);
    expect(String(await fake.readFile(box.name, '/w/TICKET.md'))).toBe('# T');
    expect(fake.calls.map((c) => c.method)).toEqual(['createNetwork', 'startSandbox', 'exec', 'exec', 'copyIn', 'readFile']);
  });

  it('kill ends an interactive exec', async () => {
    const fake = createFakeRuntime();
    fake.onExec(/./, async (ctx) => {
      await ctx.killed;
    });
    const h = fake.exec('c', ['sleep']);
    h.kill();
    expect(await h.done).toEqual({ code: null, signal: 'SIGKILL', timedOut: false });
  });

  it('destroy and sweep remove what they should; the boot sweep keeps live sessions', async () => {
    const fake = createFakeRuntime();
    for (const sessionId of ['a', 'b', 'c']) {
      await fake.createNetwork({ sessionId, accountId: 1 });
      await fake.createVolume({ sessionId, accountId: 1 }, 'work');
    }
    expect((await fake.destroy('a')).networks).toEqual(['limn-a-net']);
    expect(await sweepSandboxesAtBoot({ runtime: fake, liveSessionIds: ['b'] })).toEqual({ containers: [], networks: ['limn-c-net'], volumes: ['limn-c-vol-work'], images: [], errors: [] });
    expect(fake.resources().map((r) => r.name).sort()).toEqual(['limn-b-net', 'limn-b-vol-work']);
  });

  it('the boot sweep does nothing without a container CLI or daemon', async () => {
    expect(await sweepSandboxesAtBoot({ env: { PATH: '/nonexistent' } })).toBeNull();
    const fake = createFakeRuntime();
    fake.setDetection({ daemonReachable: false, available: false });
    expect(await sweepSandboxesAtBoot({ runtime: fake })).toBeNull();
  });

  it('a sweep while Limn runs reads the live sessions in the same tick, and holds the gate until it ends', async () => {
    const fake = createFakeRuntime();
    fake.plant({ kind: 'container', name: 'limn-a-sandbox', sessionId: 'a', role: 'sandbox' });
    fake.plant({ kind: 'container', name: 'limn-b-sandbox', sessionId: 'b', role: 'sandbox' });
    let release: () => void = () => {};
    const slow = { ...fake, sweep: async (live: Iterable<string>) => (await new Promise<void>((r) => (release = r)), fake.sweep(live)) };
    let liveIds = ['b'];
    const p = sweepSandboxesNow({ liveSessionIds: () => liveIds, backends: [slow as typeof fake] });
    // A session registered after the call is not in this sweep's list: it must wait for the gate.
    liveIds = ['a', 'b'];
    let settled = false;
    void sweepSettled().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    release();
    expect((await p)?.result.containers).toEqual(['limn-a-sandbox']);
    await sweepSettled();
    expect(fake.resources().map((r) => r.name)).toEqual(['limn-b-sandbox']);
  });

  it('counts the running sandboxes; null when no backend answers', async () => {
    const fake = createFakeRuntime();
    fake.plant({ kind: 'container', name: 'limn-a-sandbox', sessionId: 'a', role: 'sandbox' });
    fake.plant({ kind: 'container', name: 'limn-a-proxy', sessionId: 'a', role: 'proxy' });
    expect(await listRunningSandboxes({ backends: [fake] })).toEqual([{ name: 'limn-a-sandbox', sessionId: 'a' }]);
    fake.setDetection({ daemonReachable: false, available: false });
    expect(await listRunningSandboxes({ backends: [fake] })).toBeNull();
  });
});
