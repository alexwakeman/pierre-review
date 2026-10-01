// THE AI FIX PANE'S TWO START BUTTONS OPEN ON ONE MODEL, AND ITS PUSH IS AS-IS.
//
// The pane starts a fix from two places: the fixer's own picker (AiFixTab) and the CI card's
// "Fix it" (CiAnalysisCard, also mounted on the Overview). They used to carry their own model-id
// literals, and the server a third, so the three could drift apart silently. All of them now read
// ONE constant, `DEFAULT_AI_FIX_MODEL` in packages/shared (Opus 5.5, effort pinned to medium in
// apps/backend/src/review/model-options.ts); this pins the two SPA halves to it. The server half is
// pinned by packages/pro/test/ai-fix-routes.test.ts, the constant itself by
// apps/backend/src/review/claude-review-ticket.test.ts.
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
const card = code(read('components/CiAnalysisCard.tsx'));

describe('the AI Fix pane starts fixes on the shared default', () => {
  it('the fixer picker opens on DEFAULT_AI_FIX_MODEL', () => {
    expect(tab).toMatch(/useState<AiFixModel>\(DEFAULT_AI_FIX_MODEL\)/);
  });

  it("the CI card's Fix it sends DEFAULT_AI_FIX_MODEL", () => {
    expect(card).toMatch(/startFix\.mutate\(\{\s*model:\s*DEFAULT_AI_FIX_MODEL\b/);
  });

  it('both import it from the shared package', () => {
    for (const src of [tab, card]) {
      expect(src).toMatch(/DEFAULT_AI_FIX_MODEL[\s\S]*?from '@pierre-review\/shared'/);
    }
  });

  it('neither carries a model-id literal of its own', () => {
    expect(tab).not.toMatch(MODEL_LITERAL);
    expect(card).not.toMatch(MODEL_LITERAL);
  });

  it('the literal scan is not vacuous', () => {
    // The pattern must catch the literal the CI card used to hard-code.
    expect(`startFix.mutate({ model: 'claude-sonnet-5', seed: 'ci_analysis' })`).toMatch(
      MODEL_LITERAL,
    );
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
