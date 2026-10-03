// THE AI FIX PANE'S START BUTTONS OPEN ON ONE MODEL, AND ITS PUSH IS AS-IS.
//
// The pane's two entry points ("Fix from review" and the instruction box) share one model picker,
// which opens on ONE constant, `DEFAULT_AI_FIX_MODEL` in packages/shared (Opus 5.5, effort pinned
// to medium in apps/backend/src/review/model-options.ts) — the same constant the start route falls
// back to (apps/backend/src/coding/ai-fix/routes.test.ts). The CI card's "Fix it" went with the
// card.
//
// It also pins the push body: the rebase / merge / "let Claude resolve conflicts" strategies were
// removed, so the pane sends only `target` + `branch`.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend aiFixModelDefault
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
// Comments explain the rule in the very words a guard looks for, so scan code only.
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// Any quoted Claude model id: 'claude-opus-5-5', "claude-sonnet-5", `claude-haiku-4-5`, …
const MODEL_LITERAL = /['"`]claude-[a-z0-9.-]+['"`]/;

const tab = code(read('components/AiFixTab.tsx'));

describe('the AI Fix pane starts fixes on the shared default', () => {
  it('the fixer picker opens on DEFAULT_AI_FIX_MODEL', () => {
    expect(tab).toMatch(/useState<AiFixModel>\(DEFAULT_AI_FIX_MODEL\)/);
  });

  it('imports it from the shared package', () => {
    expect(tab).toMatch(/DEFAULT_AI_FIX_MODEL[\s\S]*?from '@pierre-review\/shared'/);
  });

  it('carries no model-id literal of its own', () => {
    expect(tab).not.toMatch(MODEL_LITERAL);
  });

  it('the literal scan is not vacuous', () => {
    expect(`startFix.mutate({ model: 'claude-sonnet-5', seed: 'plain' })`).toMatch(MODEL_LITERAL);
  });
});

describe('the push panel pushes as-is', () => {
  it('sends only target and branch — no strategy, no conflict resolution, no model', () => {
    expect(tab).toMatch(/push\.mutate\(\{/);
    expect(tab).not.toMatch(/\bstrategy\b/);
    expect(tab).not.toMatch(/autoResolve/);
    // The only model reference left in the push panel would be a resolver's; there is none.
    expect(tab).not.toMatch(/fix\.model/);
  });
});
