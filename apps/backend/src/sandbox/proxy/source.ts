// THE PROXY'S PROGRAM, as text for `node --input-type=module -e` (docs/SANDBOX.md § The egress proxy).
// The proxy runs from the sandbox image with NO host mount and NO copy step: its whole program is the
// container's command. In a release that is the compiled `server.js` beside this file; in a dev
// checkout (tsx, no build) it is `server.ts` with its types stripped by Node's own
// `module.stripTypeScriptTypes` (Node ≥ 22.13), which is why server.ts keeps to erasable syntax.
//
// ⚠ Refused when the program imports anything but a `node:` built-in: there is nothing else in the
// container to import, and a silent failure there would be a session with no way out.
import { existsSync, readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every module specifier in an ES module's static imports and re-exports. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push((m[1] ?? m[2]) as string);
  return out;
}

export function assertSelfContained(source: string): void {
  const bad = importSpecifiers(source).filter((s) => !s.startsWith('node:'));
  if (bad.length) throw new Error(`The egress proxy program must import node: built-ins only; it imports ${bad.join(', ')}`);
  if (/\bimport\s*\(/.test(source)) throw new Error('The egress proxy program must not use dynamic import()');
}

let cached: string | null = null;

export function proxyProgramSource(dir: string = HERE): string {
  if (cached !== null && dir === HERE) return cached;
  let source: string;
  const js = join(dir, 'server.js');
  const ts = join(dir, 'server.ts');
  if (existsSync(js)) {
    source = readFileSync(js, 'utf8');
  } else if (existsSync(ts)) {
    const strip = (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, o?: { mode?: string }) => string }).stripTypeScriptTypes;
    if (typeof strip !== 'function') throw new Error('Running the egress proxy from source needs Node 22.13 or later (module.stripTypeScriptTypes).');
    source = strip(readFileSync(ts, 'utf8'), { mode: 'strip' });
  } else {
    throw new Error(`The egress proxy program is missing (${js})`);
  }
  // Drop a trailing source-map comment: the file it names does not exist in the container.
  source = source.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
  assertSelfContained(source);
  if (dir === HERE) cached = source;
  return source;
}
