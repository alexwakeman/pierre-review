// THE SESSION'S BROWSER on the host (browser/index.ts) over a fake runtime: started once (a second ask waits for the
// first), ready only when its DevTools port answers, a failure is one notice, and the relay verbs.
import { describe, expect, it } from 'vitest';
import type { ExecResult, SandboxRuntime } from '../runtime/types.js';
import { SessionBrowser } from './index.js';

function setup(o: { startFails?: boolean; readyAfter?: number; noBrowser?: boolean } = {}) {
  const calls: string[] = [];
  const noted: string[][] = [];
  const notices: string[] = [];
  let probes = 0;
  const runtime = {
    ...(o.noBrowser
      ? {}
      : {
          startBrowser: async (spec: { sandbox: string; proxyUrl: string | null }) => {
            calls.push(`start ${spec.sandbox} ${spec.proxyUrl}`);
            if (o.startFails) throw new Error('pull failed');
            return { name: 'limn-s1-browser' };
          },
          stopBrowser: async () => void calls.push('stop'),
        }),
    run: async (_c: string, argv: string[]): Promise<ExecResult> => {
      probes += 1;
      expect(argv.slice(0, 2)).toEqual(['node', '-e']);
      return { code: probes > (o.readyAfter ?? 0) ? 0 : 1, stdout: Buffer.alloc(0), stderr: '', timedOut: false };
    },
  } as unknown as SandboxRuntime;
  const b = new SessionBrowser({ runtime, owner: { sessionId: 's1', accountId: 1 }, sandbox: 'limn-s1-sandbox', proxyUrl: 'http://limn-proxy:3128', notice: (t) => void notices.push(t), onShots: async (p) => void noted.push([...p]), probeEveryMs: 1 });
  const run = async (...argv: string[]) => {
    let out = '';
    let err = '';
    const code = await b.handle(argv, '/', (s, t) => (s === 'o' ? (out += t) : (err += t)));
    return { code, out, err };
  };
  return { b, calls, notices, noted, run, probes: () => probes };
}

describe('the session browser', () => {
  it('starts once, in the sandbox\'s network, through the proxy; ready when DevTools answers', async () => {
    const t = setup({ readyAfter: 2 });
    const [a, b] = await Promise.all([t.b.start('reader'), t.b.start('agent')]);
    expect([a, b]).toEqual([true, true]);
    expect(t.calls).toEqual(['start limn-s1-sandbox http://limn-proxy:3128']);
    expect(t.probes()).toBe(3);
    expect(t.notices).toEqual(['Ensemble started a browser for the build.']);
    expect(await t.b.start('agent')).toBe(true);
    expect(t.calls).toHaveLength(1);
  });

  it('a failed start is one notice, and the build goes on', async () => {
    const t = setup({ startFails: true });
    expect(await t.b.start('reader')).toBe(false);
    expect(t.notices).toEqual(['The browser did not start. The build goes on without it.']);
    expect((await t.run('status')).out).toBe('The browser did not start.\n');
  });

  it('the agent\'s verbs: status, start, stop', async () => {
    const t = setup();
    expect((await t.run('status')).out).toContain('No browser is running');
    const s = await t.run('start');
    expect(s.code).toBe(0);
    expect(s.out).toContain('The browser is running.');
    expect(t.notices).toEqual(['The agent started a browser.']);
    expect((await t.run('start')).out).toBe('The browser is already running.\n');
    expect((await t.run('stop')).out).toBe('The browser is stopped.\n');
    expect(t.calls.at(-1)).toBe('stop');
    expect((await t.run('rm')).code).toBe(2);
  });

  it('a runtime with no browser says so in one line, and never starts one', async () => {
    const t = setup({ noBrowser: true });
    const r = await t.run('start');
    expect(r.code).toBe(1);
    expect(r.err).toContain('runs only on Docker');
    expect(await t.b.start('reader')).toBe(false);
    expect(t.notices).toEqual([]);
  });

  it('after close, nothing starts', async () => {
    const t = setup();
    t.b.close();
    expect(await t.b.start('reader')).toBe(false);
    expect(t.calls).toEqual([]);
  });

  it('noted: the CLI\'s own call after a shot hands the paths on (at most six), quietly', async () => {
    const t = setup();
    const paths = Array.from({ length: 8 }, (_, i) => `/home/agent/.limn/browser/s${i}.png`);
    const r = await t.run('noted', ...paths);
    expect(r).toEqual({ code: 0, out: '', err: '' });
    expect(t.noted).toEqual([paths.slice(0, 6)]);
  });
});
