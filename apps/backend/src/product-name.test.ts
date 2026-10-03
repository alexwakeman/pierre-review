// THE PRODUCT-NAME GUARD. The app is called Limn; it used to be called Pierre, and the rename
// was staged so that the published identifiers (the `pierre_session` cookie, the `'pierre'` reviewer kind, the `<!-- pierre:claude-review -->`
// marker) deliberately keep the old spelling FOREVER. That split is what makes this hard to test:
// a blanket "no pierre anywhere" scan would fail on every one of those, and a blanket
// find-and-replace would sign every cloud user out and break Limn's own review detection.
//
// So this file checks the thing that actually rots: USER-VISIBLE strings. Three of them had
// already drifted back before anyone noticed — a Slack digest emitting "Pierre · Claude" months
// after its two twins were renamed, a rendered tooltip, and a Haiku prompt whose `## Fixability
// by Pierre` heading was stored raw and rendered straight through <Markdown> onto a card.
//
// ⚠ WHY THE SOURCE SCANS ARE SHAPED THE WAY THEY ARE. A previous source-scan guard in this repo
// was silently blinded by a `;` inside a comment, because it tried to understand the code. These
// do not parse anything:
//   · the prompt scan looks at lines that START a Markdown heading (`^## …`). A `//` comment can
//     never be one, so the explanatory comments in that file — which DO name the old brand,
//     because they record why the read-time patch exists — cannot hide a real regression.
//   · the label-map scans assert STRUCTURE (does this object spread the shared map / does it
//     declare its own `pierre:` key at the start of a line), never prose.
//   · everything else is a behavioural assertion on an evaluated value, where a comment cannot
//     reach at all.
//
// Lives in the backend because `pnpm test` (recursive vitest) runs ONLY the backend — the
// frontend's and the plugin's own suites are hand-run. The plugin is a submodule, so its files
// are scanned only when they are checked out.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERIC_REVIEWER_LABELS, PRODUCT_NAME } from '@pierre-review/shared';
import { labelFor } from './sync/reviewer-classify.js';
import { fingerprintReview } from './sync/review-fingerprint.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string): string => readFileSync(REPO_ROOT + rel, 'utf8');

/**
 * Is the private plugin checked out AT ALL? Decided ONCE, off its entry point.
 *
 * ⚠ IT IS ONE QUESTION, NOT ONE PER FILE, AND THAT IS THE WHOLE POINT. The four plugin scans used
 * to open with `if (!present(rel)) return;`, and vitest reports a test body that returns without
 * asserting as PASSED, never as skipped. So in CI — where `.github/workflows/ci.yml` checks out
 * with a bare `actions/checkout@v4` and no `submodules:` — those four reported green with zero
 * assertions, over exactly the three surfaces this file's header says had already rotted. Worse,
 * the guard was keyed on each FILE's path: moving `src/ai-fix/prompts.ts` would have disabled two
 * of them silently for a developer with the submodule fully checked out. `describe.skipIf` reports
 * SKIPPED, and `read()` inside throws on a path that has moved.
 */
const hasPlugin = existsSync(REPO_ROOT + 'packages/pro/src/index.ts');

/** The old brand as a WORD. Case-sensitive and refusing a following `-`, `:` or `/`, exactly like
 *  the read-time patch in the plugin: every identifier that keeps the old spelling is lowercase
 *  and hyphenated (`pierre-review`, `pierre:claude-review`), so this cannot fire on one. */
const OLD_BRAND = /\bPierre\b(?![-:/])/;

describe('the product name is Limn', () => {
  it('is one constant, and the labels that compose it read from it', () => {
    expect(PRODUCT_NAME).toBe('Limn');
    expect(GENERIC_REVIEWER_LABELS.pierre).toBe(`${PRODUCT_NAME} · Claude`);
    for (const label of Object.values(GENERIC_REVIEWER_LABELS)) {
      expect(label).not.toMatch(/pierre/i);
    }
  });

  // The three copies of the reviewer label map (SPA / backend / Slack digest) disagreed on
  // BOTH unbranded keys. The backend half is the one that persists into workspace_reviewers.label.
  it('the persisted reviewer label agrees with shared', () => {
    expect(labelFor('pierre')).toBe(GENERIC_REVIEWER_LABELS.pierre);
    expect(labelFor('in_house')).toBe(GENERIC_REVIEWER_LABELS.in_house);
    expect(labelFor('vendor')).toBe(GENERIC_REVIEWER_LABELS.vendor);
    // Still "In-house / custom" and not "In-house AI" — the Slack copy had regressed to the
    // latter, which is wrong for the unbranded CLA bots and quality gates that land in this kind.
    expect(labelFor('in_house')).toBe('In-house / custom');
  });

  // The marker is frozen; only its DISPLAY NAME follows the rename. That name reaches a user as
  // a tooltip ("matched pierre fingerprint: Limn review marker").
  it('the review fingerprint keeps the old marker and shows the new name', () => {
    const fp = fingerprintReview('LGTM\n\n<!-- pierre:claude-review v=1 -->', []);
    expect(fp.tool).toBe('pierre'); // the KIND is a persisted DB value — never renamed
    expect(fp.markers.join(' ')).toContain(PRODUCT_NAME);
    expect(fp.markers.join(' ')).not.toMatch(OLD_BRAND);
  });
});

// ⚠ SKIPPED, NOT SILENTLY PASSED, when the submodule is absent — and every scan inside uses
// `read()`, which THROWS on a path that has moved. See `hasPlugin`.
describe.skipIf(!hasPlugin)('no user-visible "Pierre" in the plugin\'s rendered strings', () => {
  // The plugin's one-shot prompts. (The CI-analysis prompt, whose `##` headings once said
  // "Fixability by Pierre", is gone: Claude Review diagnoses failing CI in core.)
  it('the plugin prompts carry no old brand outside comments', () => {
    const src = read('packages/pro/src/ai-fix/prompts.ts');
    const emitted = src.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(emitted.length).toBeGreaterThan(0); // the scan found the file, not an empty one
    for (const l of emitted) expect(l).not.toMatch(OLD_BRAND);
  });

  // The Slack digest was the copy that rotted, because a digest bullet is the one place nobody
  // looks. Structural: it must spread the shared map rather than restate its keys.
  it('the Slack digest label map spreads the shared unbranded labels', () => {
    const src = read('packages/pro/src/slack/report.ts');
    expect(src).toContain('...GENERIC_REVIEWER_LABELS');
    expect(src).not.toMatch(/^\s*pierre:\s*['"`]/m);
    expect(src).not.toMatch(/^\s*in_house:\s*['"`]/m);
  });

  // The AI-fix PR body lands on GitHub, read by people who have never opened this app.
  it('the AI-fix PR body names the product, not the npm package', () => {
    // The fixer is core since apiVersion 22.
    expect(read('apps/backend/src/coding/ai-fix/routes.ts')).toContain(
      'generated by ${PRODUCT_NAME} AI Fix.',
    );
  });
});

describe('no user-visible "Pierre" in the sources that render one', () => {
  // The SPA's own label map — the third copy.
  it('the SPA vendor map reads the unbranded labels from shared', () => {
    const src = read('apps/frontend/src/lib/ui.ts');
    expect(src).toContain('GENERIC_REVIEWER_LABELS.pierre');
    expect(src).not.toMatch(/^\s*pierre:\s*\{\s*label:\s*['"`]/m);
  });

  // Whole-file scans, for files that should now contain the old brand NOWHERE — not even in a
  // comment. Strictest form of the guard, and only usable where no historical note is needed.
  it.each([
    'apps/frontend/src/components/Activity/BotPrsDetail.tsx',
    'apps/frontend/src/components/Activity/BotOnlyPrsDetail.tsx',
  ])('%s carries no "Pierre" at all', (rel) => {
    expect(read(rel)).not.toMatch(OLD_BRAND);
  });

  // This sentence is rendered in the SPA (ClaudeReviewTab / AiFixTab) via `authMessage` on the
  // wire, unbackticked and mid-paragraph, where "restart pierre-review" reads as a name.
  // The no-credential line is now ONE short sentence that names no product and no plan (it
  // replaces every Run button); it must never send anyone to a "pierre" command either.
  it('the Claude-auth message is the one plain line, with no old brand', () => {
    const src = read('apps/backend/src/review/auth.ts');
    expect(src).toContain("'Sign in to Claude Code or set ANTHROPIC_API_KEY'");
    expect(src).not.toMatch(/restart pierre/i);
  });

  // The COMMAND moved with the npm package (`limn-review`, bin `limn`); `pierre-review` survives
  // only as a deprecated alias that the usage text names as one.
  it('the CLI failure line says the product name', () => {
    const src = read('apps/backend/src/cli.ts');
    expect(src).toContain("console.error('Failed to start Limn:'");
    expect(src).toContain('  limn [options]');
    expect(src).not.toContain('  pierre-review [options]');
    expect(src).toContain('package now only forwards to this one');
  });
});
