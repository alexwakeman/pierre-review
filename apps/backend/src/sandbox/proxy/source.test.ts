// The proxy's program must run ALONE in the container: node: imports only, erasable types only.
import { describe, expect, it } from 'vitest';
import { assertSelfContained, importSpecifiers, proxyProgramSource } from './source.js';

describe('proxy program source', () => {
  it('is self-contained JavaScript (types stripped, node: imports only)', () => {
    const src = proxyProgramSource();
    expect(importSpecifiers(src).length).toBeGreaterThan(3);
    expect(importSpecifiers(src).every((s) => s.startsWith('node:'))).toBe(true);
    expect(src).not.toMatch(/^\s*export\s+(?:interface|type)\s/m);
    expect(src).toContain('createProxy');
    // Small enough for one argv element on every platform (Linux caps one at 128 KiB).
    expect(Buffer.byteLength(src)).toBeLessThan(96 * 1024);
  });

  it('parses as an ES module', async () => {
    // A data: URL import evaluates it without starting anything (LIMN_PROXY_MAIN is unset here).
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(proxyProgramSource()).toString('base64')}`)) as Record<string, unknown>;
    expect(typeof mod.createProxy).toBe('function');
    expect(typeof mod.main).toBe('function');
  });

  it('refuses a program that imports anything else', () => {
    expect(() => assertSelfContained("import x from 'left-pad';")).toThrow(/left-pad/);
    expect(() => assertSelfContained("export { a } from './a.js';")).toThrow(/a\.js/);
    expect(() => assertSelfContained("const m = await import('node:fs');")).toThrow(/dynamic/);
    expect(() => assertSelfContained("import fs from 'node:fs';\nimport { x } from \"node:net\";")).not.toThrow();
  });
});
