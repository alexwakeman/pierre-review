import type { ProContext } from '../contract.js';

// ── DEEP LINKS BACK INTO THE APP, FOR A MESSAGE READ IN SLACK ────────────────────────────────
//
// A digest that names five repositories and three stalled PRs and then offers nowhere to go is a
// notification, not a report. These build the THREE kinds of link the message carries: workspace,
// repo and PR. Every href in the message comes from here — `appBase` plus integer ids, nothing
// else — so a URL the model wrote can never survive as a link (./format.ts rewrites those to text).
//
// ⚠ THE BASE URL COMES FROM THE HOST, VIA `ctx.host.appWebUrl`. The plugin deliberately does NOT
// read `process.env.APP_BASE_URL` itself: that would be the same default written twice across the
// open-core boundary — the "TWO SPELLINGS MUST AGREE" hazard config.ts already records for the
// report model id — and a LOCAL install sets no APP_BASE_URL at all, so the plugin-side read
// would emit a hostless link on exactly the deployment this feature was asked to serve.
//
// ⚠ IT IS `appWebUrl`, THE BROWSER-FACING ORIGIN — NOT THE API ORIGIN `appBaseUrl`. The two are
// identical in every single-origin deployment (the packaged release, cloud on Railway) and differ
// under `pnpm dev`, where the backend runs on :4000 and serves NO SPA while Vite serves it on
// :5173. This module originally read the API origin, and every link it built 404'd locally.
// Core decides which is which by whether the built SPA is actually on disk beside the server
// (config.ts `serverServesSpa`); do not re-derive that judgement here.
//
// ⚠ THE SEAM IS OPTIONAL (`appWebUrl?`), so apiVersion stays 21 — and absent, every builder here
// returns null and the message simply carries no app links. A missing link degrades one line of a
// digest; a bumped apiVersion half-applied across two repos degrades the ENTIRE plugin to OSS mode
// with nothing thrown.

/**
 * The SPA's base, or null when the host did not supply one (an older host, or a deployment with
 * nothing configured). Trailing slashes are stripped so the callers below can concatenate.
 */
export function appBase(ctx: ProContext): string | null {
  const raw = ctx.host.appWebUrl;
  if (raw == null) return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  // Only absolute http(s). Anything else cannot be clicked from Slack, and a relative value would
  // render as literal text in the middle of a message.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

// The SPA is served under `/app/` in BOTH modes (local redirects `/` → `/app`; cloud puts the
// landing page at `/`), so every link below is rooted there.
const SPA_PATH = '/app/';

/**
 * The header link: this workspace's Activity FEED — the digest summarises activity, so it opens the
 * stream it summarises. `activityRepo=feed` is spelled out because the app now opens on Pending:
 * a bare `?view=activity` would land there instead.
 *
 * `?workspace=<id>` is THE scope parameter, and `view=activity` is the rail the digest describes.
 * Both are the SPA's own URL vocabulary (useUrlState.ts) — not a second spelling invented here.
 */
export function workspaceLink(ctx: ProContext, workspaceId: number): string | null {
  const base = appBase(ctx);
  if (base == null) return null;
  return `${base}${SPA_PATH}?view=activity&workspace=${workspaceId}&activityRepo=feed`;
}

/**
 * A per-repo section link: the workspace's Activity rail, focused on one repository.
 *
 * `activityRepo=<repoId>` is a LOCAL repo id, which is safe here precisely because it never leaves
 * the tenant: it is read from this account's own digest rows and rendered into this account's own
 * channel.
 *
 * Per-PR references are Limn links too (`prLink`). This reverses the earlier github.com rule at the
 * user's request, because the report is read in order to act, and acting happens in Limn. The link
 * carries the LOCAL `prId` the ref already holds, since every ref comes from an account-scoped
 * resolver. The number→ref step stays repo-aware in ./format.ts, because a PR number resolves to a
 * local id only within (accountId, repoId). A reader with no access to this Limn now reaches its
 * sign-in page (cloud) or an unreachable host (local), not GitHub. Without a base URL every builder
 * returns null and the reference is plain text, never a GitHub fallback.
 */
export function repoLink(ctx: ProContext, workspaceId: number, repoId: number): string | null {
  const base = appBase(ctx);
  if (base == null) return null;
  return `${base}${SPA_PATH}?view=activity&workspace=${workspaceId}&activityRepo=${repoId}`;
}

/**
 * One Pending tab in this workspace: `activityRepo=attention` is the board (spelled out, like the
 * Feed link above, so a persisted rail choice cannot win) and `attnTab=<key>` the tab — both parsed
 * by useUrlState.ts. `tabKey` is a `PendingTabKey`, never data from a message.
 */
export function pendingLink(ctx: ProContext, workspaceId: number, tabKey: string): string | null {
  const base = appBase(ctx);
  if (base == null) return null;
  return `${base}${SPA_PATH}?view=activity&workspace=${workspaceId}&activityRepo=attention&attnTab=${encodeURIComponent(tabKey)}`;
}

// Spelled here because the plugin cannot import the frontend. Its readers are
// `apps/frontend/src/store/pinnedTabs.ts` `prDetailKey`/`parseTabKey` and
// `hooks/useUrlState.ts` `landingTabFromUrl`. Pinned by a source scan in
// test/slack-pr-links.test.ts.
const PR_DETAIL_TAB_PREFIX = 'pr-detail:';

/**
 * A PR's own tab in Limn: `?workspace=<id>&view=pr-detail%3A<prId>` — the SPA re-creates the tab
 * from the key alone (`applyUrlTab`), so a browser that has never seen the PR still opens it.
 * `prId` is a LOCAL id and must come only from a ref an account-scoped resolver produced. null
 * when the host gave no base.
 */
export function prLink(ctx: ProContext, workspaceId: number, prId: number): string | null {
  const base = appBase(ctx);
  if (base == null) return null;
  return `${base}${SPA_PATH}?workspace=${workspaceId}&view=${encodeURIComponent(
    `${PR_DETAIL_TAB_PREFIX}${prId}`,
  )}`;
}

/** Slack message text has exactly three special characters. `&` goes first so an escape is never
 *  double-escaped. Model output, PR titles and the workspace name all pass through here, so none of
 *  them can forge a `<url|…>` link or write `<!channel>`. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Text that goes INSIDE `<url|…>`: escaped, and a `|` cannot end the label early. */
export function slackLinkText(s: string): string {
  return escapeSlack(s).replace(/\|/g, '¦');
}

/** `<url|text>` — Slack mrkdwn's link form. Returns the (escaped) bare text when there is no URL.
 *  `text` is RAW: it is escaped here, because callers pass user-typed names (the footer's
 *  workspace name). */
export function slackLink(url: string | null, text: string): string {
  return url == null ? escapeSlack(text) : `<${url}|${slackLinkText(text)}>`;
}
