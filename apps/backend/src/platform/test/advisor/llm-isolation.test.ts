// STRUCTURAL LLM-ISOLATION — the advisor's governing design constraint, enforced on the
// import graph itself: the deterministic pipeline (taxonomy / findings / intents / evidence /
// retro-check / emitters/*) must be INCAPABLE of reaching the LLM, not merely disciplined
// about it. Two assertions:
//   (a) the transitive import closure of every deterministic module never reaches
//       src/advisor/refine/ or src/llm/;
//   (b) no deterministic module's source mentions ctx.llm / llm.complete / cheapComplete.
// Primary enforcement is the no-`ctx` signature discipline (violating it needs a visible
// signature change in review); this test is the local tripwire — plugin tests don't run in
// CI, so it exists to fail loudly on a dev machine before review.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../..');
const ADVISOR = join(SRC, 'advisor');

// The deterministic set: everything under advisor/ EXCEPT the modules that legitimately hold
// ctx (routes/store/measure/discovery) and the one LLM module family (refine/).
const CTX_ALLOWED = new Set(['routes.ts', 'store.ts']);
const CTX_ALLOWED_DIRS = new Set(['measure', 'discovery', 'refine']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function deterministicModules(): string[] {
  if (!existsSync(ADVISOR)) return [];
  return walk(ADVISOR).filter((p) => {
    const rel = p.slice(ADVISOR.length + 1);
    const top = rel.split('/')[0]!;
    if (CTX_ALLOWED_DIRS.has(top)) return false;
    if (rel.split('/').length === 1 && CTX_ALLOWED.has(rel)) return false;
    return true;
  });
}

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push(m[1]!);
  return out;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare specifier (shared types etc.) — not ours
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate;
  }
  return null;
}

function transitiveClosure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe('advisor deterministic pipeline is structurally LLM-isolated', () => {
  const roots = deterministicModules();

  it('has deterministic modules to check (the layout the plan promised exists)', () => {
    expect(roots.length).toBeGreaterThan(5);
  });

  it('the transitive import closure never reaches refine/ or the llm seam', () => {
    const closure = transitiveClosure(roots);
    const offenders = [...closure].filter(
      (f) => f.includes(`${ADVISOR}/refine/`) || f.includes(join(SRC, 'llm/')),
    );
    expect(offenders).toEqual([]);
  });

  it('no deterministic module mentions ctx.llm / llm.complete / cheapComplete', () => {
    for (const file of roots) {
      const text = readFileSync(file, 'utf8');
      for (const needle of ['ctx.llm', 'llm.complete(', 'cheapComplete']) {
        expect(text.includes(needle), `${file} mentions ${needle}`).toBe(false);
      }
    }
  });

  it('no deterministic module takes a ctx parameter (the signature discipline)', () => {
    for (const file of roots) {
      const text = readFileSync(file, 'utf8');
      expect(/\bctx\s*:\s*ProContext\b/.test(text), `${file} takes ctx`).toBe(false);
    }
  });
});
