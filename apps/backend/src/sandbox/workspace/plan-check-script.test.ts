// THE PLAN CHECKER SCRIPT (plan-check.ts `planCheckerSource`) as the agent runs it: real node, a real git
// repository with refs/limn/base; it embeds THE validator text the host compiles.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILD_PLAN_CHECK_SOURCE, planCheckerSource } from './plan-check.js';
import { CTX, goodPlan } from './plan.test-support.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('the checker script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limn-plan-check-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('embeds THE validator text and checks quotes against refs/limn/base', () => {
    expect(planCheckerSource({ contextFile: '/x' })).toContain(BUILD_PLAN_CHECK_SOURCE);
    const repo = join(dir, 'api');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/export.ts'), 'import x from "y";\n\nexport const MAX_ROWS = 1000;\n');
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/limn/base', 'HEAD');
    const ctxFile = join(dir, 'plan-context.json');
    writeFileSync(ctxFile, JSON.stringify({ ...CTX, repoPaths: { 'acme/api': repo, 'acme/web': repo }, docsDir: null }));
    const script = join(dir, 'plan-check.cjs');
    writeFileSync(script, planCheckerSource({ contextFile: ctxFile }));
    const run = (input: string): { code: number; out: string } => {
      try {
        return { code: 0, out: execFileSync('node', [script], { input, encoding: 'utf8' }) };
      } catch (e: any) {
        return { code: e.status, out: String(e.stdout) };
      }
    };
    const good = goodPlan();
    expect(run(`Here it is:\n\`\`\`limn-plan\n${JSON.stringify(good)}\n\`\`\`\n`)).toEqual({ code: 0, out: 'OK\n' });
    const wrong = goodPlan();
    wrong.contentions[0].evidence[0].quote = 'const MAX_ROWS = 5000;';
    const r = run(JSON.stringify(wrong));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/the quote is not in src\/export.ts at the base commit/);
    expect(run('{not json').out).toMatch(/not valid JSON/);
  });
});
