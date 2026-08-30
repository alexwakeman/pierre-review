import type { ReactNode } from 'react';

import { ExternalLinkIcon, LockIcon } from './Icons.js';
import { useMe } from '../hooks/useTriage.js';

// THE ONE PRO INDICATOR. Every surface that is Pro-only wears the badge and the locked pane
// from this file, and nothing anywhere hand-rolls either — five surfaces drifting into five
// slightly different vermilion chips is exactly how "is this broken or is this paid?" gets
// asked in a support thread.
//
// ── WHAT CHANGED, AND WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
// The app's older posture on a capability the account does not have is ABSENCE: the control is
// simply not rendered (`WorkspaceBotCharts` returns null; `AskAboutPeriod` in PeriodReportsPanel
// and `NarrativePanel` in PeopleReportDetail — both `activityDigest` — render nothing; the
// "Depth →" pill is omitted). That posture is deliberate and STAYS on those surfaces — a nudge on
// every hidden control turns a product into a billboard.
//
// ⚠ DO NOT cite `PersonPeriodSection` as an example of it. It USED to be one and is now the
// opposite: it renders a `ProLockPanel` on the contributor-activity tab, because that tab is the
// only place an unentitled reader can meet the People report at all.
//
// Five named surfaces now do the opposite: Chronology, period reports, the People report, the
// by-workspace comparison and the Bots ROI panel are VISIBLE-BUT-LOCKED. The reader sees the
// tab, the tab says Pro, and clicking it lands on a calm statement of what the view answers
// plus one way to read more. The reversal is scoped to those five; do not "make it consistent"
// by converting the absent ones.
//
// ── THE THREE RULES THIS COMPONENT KEEPS ─────────────────────────────────────────────────────
//  1. IT NEVER READS A CAPABILITY. The caller passes entitlement in, so the gate is legible at
//     the call site and the same component serves `periodReports` and `botDepth` without
//     growing a `which` prop. (`deploymentMode` is not a capability — it is a deployment fact,
//     and it lives here so the upgrade URL is decided in exactly one place.)
//  2. IT SAYS WHAT THE VIEW ANSWERS, NOT WHAT IT COSTS. A locked pane whose only content is a
//     price is an advert. A locked pane that names the question ("every hour a PR was open,
//     who was holding it") is still useful to someone who will never pay — they now know the
//     product has an answer to a question they have.
//  3. IT IS AN EMPTY STATE, NOT AN INTERSTITIAL. Dashed border, one heading, one or two
//     sentences, one link. It sits in the layout where the real pane would be, at the same
//     visual weight as "Nothing to measure in this Workspace yet."
//
// ── A CLIENT GATE IS NOT A MONETISATION GATE ─────────────────────────────────────────────────
// Nothing in this file enforces anything. Every surface using it must ALSO 402 server-side and
// gate its hooks' `enabled` on the same flag, or the SPA hammers a 402 on a timer and the data
// stays downloadable by URL. This file only decides what the reader sees.

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Where "read more" goes
   ───────────────────────────────────────────────────────────────────────────────────────── */

// TWO SPELLINGS OF ONE DESTINATION, because the landing site is not always served.
//
//  • CLOUD — the landing is served at the origin root and the SPA at /app (app.ts:187-194; the
//    not-found handler serves the prerendered landing for any non-/api, non-/app path,
//    error-handler.ts:112-122). So a SAME-ORIGIN '/pricing' is a real page, and it is the RIGHT
//    one: a self-hosted cloud deployment on its own domain must send its own readers to its own
//    pricing page, not to ours.
//  • LOCAL / OSS — the landing is NEVER served: '/' 302s to '/app/' (error-handler.ts:125). A
//    relative '/pricing' would be a dead link that bounces into the app, so local uses the
//    canonical public URL. It is not invented: apps/landing/src/lib/routes.ts:24 declares
//    `SITE_URL = 'https://pierre-review.com'` (with the note that the domain deliberately does
//    NOT follow the Limn rename, because Safe Browsing / Search Console verification and both
//    GitHub OAuth callbacks are registered against it), '/pricing' is a canonical prerendered
//    route in that same table (routes.ts:60), and README.md:32 links the live site.
//
// Both are hardcoded constants, not data-derived, so `safeExternalUrl()` has nothing to do here
// — it exists for third-party strings (check-run `details_url` and friends). Do not swap either
// for a value read off an API response without routing it through that helper.
//
// ⚠ THE LOCAL/OSS LINK LEAVING THE INSTALL IS A DECISION, NOT AN OVERSIGHT — and it fires more
// often than it looks. `entitledProCapabilities` short-circuits on `isLocal` to whatever the bound
// plugin published, and the plugin publishes `periodReports`/`botDepth` as
// `PRO_DIGEST_ENABLED === 'true'` — so an ordinary flag-less `pnpm dev` WITH the submodule checked
// out renders all five locked panes, each offering this off-site link. `pnpm demo` and the shots
// Pro pass set the flag; the ordinary dev loop does not (`PRO_DIGEST_ENABLED=true` is the
// fully-entitled local run, recorded in CLAUDE.md § Tiers).
//
// It is kept because the brief's posture is "one upgrade action", and because the alternative — a
// locked pane with NO action — reads as broken rather than as unbought on the one deployment where
// a reader genuinely cannot tell "not built" from "not included". A developer seeing it on their
// own machine is a mild cost; a self-hoster seeing a dead end is a worse one.
//
// If the landing ever moves, this is the only place in the SPA that names it.
const PUBLIC_PRICING_URL = 'https://pierre-review.com/pricing';
const SAME_ORIGIN_PRICING_PATH = '/pricing';

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The badge
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Which of the three existing chip spellings to draw. All three already shipped; they are
 * collected here so no call site re-types a vermilion literal.
 *
 *  • `inline`  — the nudge chip that leads a sentence (DetectedReviewersTable, SynthesisCard,
 *                BotThemesPanel's nudge). Pair with `className="mr-1"` when it precedes text.
 *  • `tab`     — the small uppercase chip on a sub-tab label (the Advisor tab in BotsView).
 *  • `heading` — the chip beside a section `<h3>` (the "Period reports" heading in InsightsView).
 */
export type ProBadgeVariant = 'inline' | 'tab' | 'heading';

export interface ProBadgeProps {
  /** Default `'inline'`. */
  variant?: ProBadgeVariant;
  /** Extra layout classes for the call site (`mr-1`, `shrink-0`, …). Never colour. */
  className?: string;
  /**
   * Plain-text tooltip. An attribute value is TEXT — it cannot hold an SVG and it cannot hold
   * a glyph that means anything, so write a sentence.
   */
  title?: string;
  /**
   * What a screen reader hears in place of the visible "Pro". Default `'Pro feature'`, which
   * makes a tab announce as "Chronology, Pro feature" rather than the bare "Chronology pro".
   * Keep it SHORT — on a tab it becomes part of the control's accessible name.
   */
  srLabel?: string;
}

const BADGE_CLASS: Record<ProBadgeVariant, string> = {
  // The canonical nudge language, matched to DetectedReviewersTable.tsx:331 exactly.
  inline: 'rounded bg-ai-signal/15 px-1 text-[10px] font-semibold text-ai-signal',
  // BotsView.tsx:112-116 — the Advisor tab's chip.
  tab: 'rounded bg-ai-signal/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-ai-signal',
  // InsightsView.tsx:146-148 — the section-heading chip.
  heading:
    'rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal',
};

/**
 * The small "Pro" chip. A LABEL, never a button — it has no click target, because the thing it
 * labels (a tab, a heading) is the click target, and a chip that navigates inside a tab button
 * is a nested interactive control.
 *
 * It draws in `--ai-signal`, so it inherits the theme in both directions and needs no dark:
 * variant. Do not give it a lock icon: at 9-10px a padlock is a smudge, and the word already
 * says it. The lock belongs on `ProLockPanel`, at panel scale.
 */
export function ProBadge({
  variant = 'inline',
  className,
  title,
  srLabel = 'Pro feature',
}: ProBadgeProps): JSX.Element {
  return (
    <span
      className={`${BADGE_CLASS[variant]}${className ? ` ${className}` : ''}`}
      title={title}
    >
      <span aria-hidden="true">{variant === 'inline' ? 'Pro' : 'pro'}</span>
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The locked pane
   ───────────────────────────────────────────────────────────────────────────────────────── */

export interface ProLockPanelProps {
  /** Names the VIEW, not the plan. "Chronology", not "Chronology is Pro". */
  heading: string;
  /**
   * One or two sentences saying what question this view answers, in the reader's terms. Not a
   * feature list, not a price, no exclamation marks. Passed as children so a call site can put
   * a `<strong>` or a second `<p>` in it.
   */
  children: ReactNode;
  /**
   * Test id for the locked body. ⚠ Give it one DISTINCT from the entitled body's — the landing
   * screenshot pipeline waits on `bot-roi-panel` (scripts/capture-shots.mjs:213) and would
   * happily photograph a lock screen if both states answered to the same id.
   */
  testId?: string;
  /** Layout only (spacing at the call site). Never colour. */
  className?: string;
}

/**
 * The pane an unentitled reader lands on. One heading, one or two sentences, one link.
 *
 * Deliberately built like the "Nothing to measure in this Workspace yet." empty state
 * (InsightsView.tsx:126-131) — same rounded-lg, same dashed border, same padding, same centred
 * text — because that is the visual grammar this app already uses for "there is nothing here
 * for you right now". The only differences are the signal tint and the padlock, which say WHY.
 *
 * It renders unconditionally when mounted: the caller owns the decision (see `useProGateState`).
 */
export function ProLockPanel({
  heading,
  children,
  testId,
  className,
}: ProLockPanelProps): JSX.Element {
  // NOT a capability read — the deployment mode decides whether the landing site exists on this
  // origin. Keeping it here is what makes this the only file in the SPA that names the URL.
  const isCloud = useMe().data?.deploymentMode === 'cloud';
  const href = isCloud ? SAME_ORIGIN_PRICING_PATH : PUBLIC_PRICING_URL;

  return (
    <div
      data-testid={testId}
      className={`rounded-lg border border-dashed border-ai-signal/25 bg-ai-signal/5 p-6 text-center${
        className ? ` ${className}` : ''
      }`}
    >
      <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200">
        <LockIcon size={13} className="shrink-0 text-ai-signal" />
        {heading}
      </div>
      <div className="mx-auto mt-1.5 max-w-md text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
        {children}
      </div>
      <div className="mt-3">
        {/*
          One action, and it reads as a link because it IS one — it opens a page, it does not
          take a payment. New tab in both modes: leaving the SPA discards a board's worth of
          ephemeral state (open tabs, the selected PR, an unsent reply draft).
        */}
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded border border-ai-signal/40 bg-ai-signal/10 px-2.5 py-1 text-[11px] font-medium text-ai-signal hover:bg-ai-signal/20"
        >
          See what Pro includes
          <ExternalLinkIcon size={11} />
        </a>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Deciding when to show it
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * `'pending'` while `/api/me` is still in flight, then `'entitled'` or `'locked'`.
 *
 * ⚠ THIS EXISTS TO STOP THE PANEL FLASHING AT PAYING CUSTOMERS. `useProCapabilities()` returns
 * an ALL-FALSE literal until `/api/me` resolves (hooks/useTriage.ts:127-146), so a branch
 * written as the obvious `!periodReports ? <ProLockPanel/> : <Real/>` paints "See what Pro
 * includes" for one frame on every cold load, for an account that pays. Route the decision
 * through here instead:
 *
 *     const gate = useProGateState(periodReports);
 *     if (gate === 'pending') return null;              // or a skeleton
 *     if (gate === 'locked') return <ProLockPanel … />;
 *
 * ⚠ AN UNRESOLVED /api/me IS `'pending'`, WHATEVER THE REASON — in flight OR errored. It is only
 * `'locked'` once a real response has said so. The earlier spelling (`me.data == null &&
 * me.isPending`) resolved an ERROR to `'locked'`, which is a claim the client is not entitled to
 * make: `useMe` sets `retry: false` (useTriage.ts) and main.tsx disables `refetchOnWindowFocus`, so
 * ONE 502 during a rolling deploy left a PAYING customer looking at "See what Pro includes" on
 * every one of these five panes until a new observer mounted. Before the visible-but-locked
 * reversal that state was invisible (the panes rendered nothing); now it actively tells someone who
 * paid that they have not. Blank is the honest render when entitlement is unknown — and a 401,
 * the one error that means something specific, is handled far above here by `<SignInGate>`
 * (App.tsx), which unmounts the boards entirely.
 *
 * It takes entitlement as an ARGUMENT so this file still reads no capability.
 */
export type ProGateState = 'pending' | 'locked' | 'entitled';

export function useProGateState(entitled: boolean): ProGateState {
  const me = useMe();
  // A true capability can only have come FROM a resolved /api/me, so it never needs the wait.
  if (entitled) return 'entitled';
  return me.data == null ? 'pending' : 'locked';
}
