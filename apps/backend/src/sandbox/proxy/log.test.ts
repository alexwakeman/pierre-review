import { describe, expect, it } from 'vitest';
import { NetworkLog, parseLogLine, type NetworkEntry } from './log.js';

const line = (o: Record<string, unknown>) => JSON.stringify({ t: '2026-11-07T00:00:00Z', ...o });

describe('network log', () => {
  it('folds repeats into one row per (source, host, port, verdict), names the source container', async () => {
    let now = 1_000;
    const lookups: string[] = [];
    const log = new NetworkLog({ now: () => now, throttleMs: 0, sourceOf: (ip) => (lookups.push(ip), ip === '172.18.0.3' ? 'limn-s1-sandbox' : null) });
    await log.ingestLine(line({ kind: 'ready' }));
    expect(log.ready).toBe(true);
    for (let i = 0; i < 3; i++) {
      now += 10;
      await log.ingestLine(line({ kind: 'connect', from: '::ffff:172.18.0.3', host: 'example.com', port: 443, allowed: false, reason: 'not_listed', status: 403 }));
    }
    await log.ingestLine(line({ kind: 'connect', from: '172.18.0.3', host: 'registry.npmjs.org', port: 443, allowed: true, status: 200, up: 10, down: 500 }));
    await log.ingestLine(line({ kind: 'connect', from: '172.18.0.3', host: 'registry.npmjs.org', port: 443, allowed: true, status: 200, up: 5, down: 100 }));
    await log.ingestLine(line({ kind: 'inject', via: 'anthropic', from: '172.18.0.9', host: 'api.anthropic.com', port: 443, allowed: true, status: 200, up: 1, down: 2 }));
    await log.ingestLine('not json');
    await log.ingestLine(line({ kind: 'control', action: 'rules' }));

    const rows = log.snapshot();
    expect(rows).toHaveLength(3);
    const denied = rows.find((r) => r.host === 'example.com')!;
    expect(denied).toMatchObject({ source: 'limn-s1-sandbox', count: 3, allowed: false, reason: 'not_listed', via: 'forward' });
    expect(rows.find((r) => r.host === 'registry.npmjs.org')).toMatchObject({ count: 2, up: 15, down: 600, reason: null });
    // An unknown address shows as itself; each address is looked up once.
    expect(rows.find((r) => r.via === 'anthropic')).toMatchObject({ source: '172.18.0.9' });
    expect(lookups).toEqual(['172.18.0.3', '172.18.0.9']);
  });

  it('caps distinct rows, folding the rest into one "other hosts" row', () => {
    const log = new NetworkLog({ maxEntries: 2, throttleMs: 0 });
    for (const h of ['a.test', 'b.test', 'c.test', 'd.test']) log.ingest({ t: '', kind: 'connect', host: h, port: 443, allowed: false }, null);
    const rows = log.snapshot();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.host === '(other hosts)')?.count).toBe(2);
  });

  it('sends a new row at once and throttles updates to it', async () => {
    let now = 0;
    const seen: NetworkEntry[] = [];
    const log = new NetworkLog({ now: () => now, throttleMs: 50 });
    log.onChange((e) => seen.push(e));
    log.ingest({ t: '', kind: 'connect', host: 'x.test', port: 443, allowed: false }, null);
    log.ingest({ t: '', kind: 'connect', host: 'x.test', port: 443, allowed: false }, null);
    log.ingest({ t: '', kind: 'connect', host: 'x.test', port: 443, allowed: false }, null);
    expect(seen.map((e) => e.count)).toEqual([1]);
    now = 60;
    await new Promise((r) => setTimeout(r, 70));
    expect(seen.map((e) => e.count)).toEqual([1, 3]);
    log.close();
  });

  it('ignores lines that are not proxy rows', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('{"no":"kind"}')).toBeNull();
    expect(parseLogLine('{"kind":"connect"}')).toEqual({ kind: 'connect' });
  });
});
