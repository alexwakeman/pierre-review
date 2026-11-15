// ---------------------------------------------------------------------------
// THE PRODUCT NAME, and the three labels that compose it.
//
// The app is called Ensemble. It was called Pierre, then Limn; each rename moved every user-visible
// string and left the stored and published identifiers on the old spelling, because changing those
// is a migration, not a text edit.
//
// THE LIMN → ENSEMBLE RENAME (2026-11). What moved: every string a person reads (SPA copy, CLI output,
// server sentences, text written to GitHub and Slack, prompts that name the product), the npm package
// (`ensemble-review`, bin `ensemble`; `limn-review` and `pierre-review` are forwarding stubs), the data
// dir (`~/.ensemble`, moved ONCE from `~/.limn` or `~/.pierre-review`), the commit-status prefix
// (`ensemble/`, written; `limn/` still read — limn-status.ts) and the user-set environment variables
// (`ENSEMBLE_X` wins, `LIMN_X` still read — backend env-name.ts). What STAYS `limn`, on purpose, and
// must never be swept:
//
//   · identifiers: function, type and file names (`limnWrite`, `isLimnStatusContext`, limn-status.ts)
//   · the stored bot login prefix `limn:<login>` (local DB only; only its DISPLAY says "Ensemble · alice")
//   · the `limn.*` localStorage keys, DB tables and columns, migrations, `/api/pro/*` paths
//   · test-only environment variables (`LIMN_TEST_RUN_DIR`, `LIMN_SCRATCH*`, `LIMN_SANDBOX_LIVE` …)
//   · git namespaces (`refs/limn/…`, `limn/…` branches), cookie names
// Every PARSER of text an older Limn wrote (status lines, PR-body headings, footers, bot names)
// reads both the old and the new wording.
//
// Still `pierre`, from the first rename (never swept either):
//
//   · the `pierre_session` / `pierre_oauth_state` cookies
//   · the ~20 `pierre:*` localStorage keys
//   · the AutomatedReviewerKind `'pierre'` — a persisted DB value AND a
//     400-validated API path segment
//   · the `refs/pierre/conflict/` git namespace the janitor sweeps by prefix
//   · `<!-- pierre:claude-review v=1 -->`, already stamped into GitHub review
//     bodies we do not control
//
// The landing has its own SITE_NAME (apps/landing/src/lib/site.ts) and imports nothing from here.
// So the name is a STRING, never an identifier. Use PRODUCT_NAME wherever the name is composed
// into a sentence or a label.
// ---------------------------------------------------------------------------

import type { GenericReviewerKind } from './types.js';

/** The product name, as a reader sees it. */
export const PRODUCT_NAME = 'Ensemble';

/**
 * Display labels for the three UNBRANDED automated-reviewer kinds.
 *
 * ⚠ SHARED IS OTHERWISE PRESENTATION-FREE AND THIS IS THE ONE EXCEPTION, narrowly. The ~80
 * BRANDED vendor labels stay in the frontend's `BOT_VENDOR_META` beside their colours, which
 * is what that rule is for. These three are different: `pierre` COMPOSES THE PRODUCT NAME, and
 * `in_house` carries a judgement ("In-house / custom", not "In-house AI" — see below) that has
 * to read the same everywhere. Three independent copies of these strings existed — the SPA's
 * `BOT_VENDOR_META`, the backend's `labelFor`, and the Pro plugin's Slack `BOT_LABELS` — and
 * they had drifted on BOTH counts: Slack was still emitting "Pierre · Claude" into digests
 * months after the other two were renamed, and "In-house AI" after the other two had rejected
 * that wording. Each of the three now reads these three keys from here.
 *
 * ⚠ "In-house / custom", NOT "In-house AI". The kind is the fallback for EVERY reviewer role,
 * so an unbranded quality gate or a CLA bot lands here — and calling those "In-house AI" is how
 * the bucket earned its reputation for being wrong. It is the role-neutral escape hatch.
 *
 * ⚠ `labelFor` in the backend WRITES these into `workspace_reviewers.label`, so they are
 * persisted as well as rendered. Changing one is a copy change that shows up on already-stored
 * rows only after the next classification pass.
 */
export const GENERIC_REVIEWER_LABELS: Readonly<Record<GenericReviewerKind, string>> = {
  in_house: 'In-house / custom',
  vendor: 'Vendor',
  // The vendor of every per-poster bot of ours ("Ensemble · alice" is the bot's own label).
  pierre: PRODUCT_NAME,
};
