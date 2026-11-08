// THE SERVICE-RUN LOG (run-log.ts) and the controller recording `limn-svc run` into it (fake runtime).
import { describe, expect, it } from 'vitest';
import { createFakeRuntime } from '../runtime/fake.js';
import { ServicesController } from './controller.js';
import { SERVICE_RUN_LOG_MAX, SERVICE_RUN_OUTPUT_MAX, ServiceRunLog, storedServiceRuns, tailOf, type ServiceRunRecord } from './run-log.js';

describe('ServiceRunLog', () => {
  it('numbers runs svc-1, svc-2 … and keeps the tail of the output', () => {
    const log = new ServiceRunLog(() => 0);
    const a = log.begin({ stack: 'api', service: 'postgres', command: ['psql', '-c', 'select 1'], egress: false });
    const b = log.begin({ stack: 'api', service: 'redis', command: [], egress: true });
    expect([a.id, b.id]).toEqual(['svc-1', 'svc-2']);
    log.append(a, 'x'.repeat(SERVICE_RUN_OUTPUT_MAX));
    log.append(a, 'TAIL\n');
    log.finish(a, 0);
    const got = log.get('svc-1')!;
    expect(got.truncated).toBe(true);
    expect(got.output.endsWith('TAIL\n')).toBe(true);
    expect(Buffer.byteLength(got.output)).toBeLessThanOrEqual(SERVICE_RUN_OUTPUT_MAX);
    expect(log.describe()).toMatch(/svc-1 {2}api\/postgres {2}exit 0 {2}psql -c select 1\nsvc-2 {2}api\/redis {2}exit … {2}\(default command\) {2}\(opened to the internet: not evidence\)/);
    expect(log.ids()).toEqual(['svc-1', 'svc-2']);
  });
  it('keeps at most SERVICE_RUN_LOG_MAX records, the oldest going first', () => {
    const log = new ServiceRunLog();
    for (let i = 0; i < SERVICE_RUN_LOG_MAX + 5; i++) log.begin({ stack: 's', service: 'x', command: [], egress: false });
    expect(log.list()).toHaveLength(SERVICE_RUN_LOG_MAX);
    expect(log.get('svc-1')).toBeNull();
    expect(log.get('svc-105')).not.toBeNull();
  });
  it('the stored copy is clipped further; a tail keeps a UTF-8 boundary', () => {
    const rec: ServiceRunRecord = { id: 'svc-1', stack: 's', service: 'x', command: [], startedAt: '', exitCode: 0, output: 'é'.repeat(20_000), truncated: false, egress: false };
    const [s] = storedServiceRuns([rec]);
    expect(s!.truncated).toBe(true);
    expect(s!.output.startsWith('é')).toBe(true);
    expect(tailOf('abc', 10)).toEqual({ text: 'abc', cut: false });
  });
});

describe('limn-svc run is recorded by the controller', () => {
  it('records the command, the host-seen output and the exit code, and prints the id', async () => {
    const fake = createFakeRuntime();
    const model = { services: { postgres: { image: 'postgres:16' }, web: { image: 'nginx:1' } } };
    fake.onExec((argv) => argv[0] === '/usr/local/bin/docker-compose', { stdout: JSON.stringify(model) });
    fake.onExec((argv) => argv[0] === 'sh', {});
    fake.onCompose((c) => (c.call.verb === 'run' ? { lines: [' count ', '-------', '  1000'], stderr: '', code: 0 } : {}));
    const seen: ServiceRunRecord[] = [];
    const c = new ServicesController({
      runtime: fake,
      owner: { sessionId: 's1', accountId: 1 },
      sandbox: 'box',
      network: 'net',
      workspaceRoot: '/ws',
      workspaceVolume: 'vol',
      stacks: [{ key: 'api', repoPath: '/ws/api', file: 'compose.yml', from: 'api/compose.yml', egress: ['web'] }],
      instance: 'test',
      onRun: (r) => seen.push(r),
    });
    let out = '';
    let err = '';
    const code = await c.handle(['run', 'postgres', 'psql', '-h', 'postgres', '-c', 'select count(*) from rows'], '/ws/api', (s, t) => (s === 'o' ? (out += t) : (err += t)));
    expect(code).toBe(0);
    expect(out).toBe(' count \n-------\n  1000\n');
    expect(err).toMatch(/limn-svc: run recorded as svc-1\n$/);
    expect(seen).toHaveLength(1);
    expect(c.runs.get('svc-1')).toMatchObject({ stack: 'api', service: 'postgres', command: ['psql', '-h', 'postgres', '-c', 'select count(*) from rows'], exitCode: 0, output: ' count \n-------\n  1000\n', egress: false });
    await c.handle(['run', 'web'], '/ws/api', () => {});
    expect(c.runs.get('svc-2')!.egress).toBe(true);
    let listed = '';
    expect(await c.handle(['runs'], '/ws/api', (_s, t) => (listed += t))).toBe(0);
    expect(listed).toMatch(/svc-1 {2}api\/postgres {2}exit 0/);
  });
});
