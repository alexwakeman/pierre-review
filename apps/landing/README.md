# @pierre-review/landing

Public marketing site for Limn (limn-review.com). Built independently — it shares no
runtime code with the timeline SPA — and served at `/` by the small site service in
[`apps/site`](../site/README.md), which also serves the contact form's API.

**Limn is local-only and 100% free.** There is no hosted app, no sign-in and no paid tier,
so the site's call to action is the npm command (`npx limn-review`). There is no hosted demo:
the product pictures are clickable HTML mocks (below). The one limit — free for individuals and for
organisations where no more than three people use it; more users than that need a licence — is stated in the home page's "Every feature, free" tiers, in the closing
block on every page, on `/contact` and in `/terms`, always from `FREE_TEAM_SIZE` in
`src/lib/site.ts` (which mirrors the Limn License at the repository root).

## Structure

A small, dependency-free multi-page site (React + Vite; Tailwind only for its preflight reset). **Five content routes** (home, `/reporting`, `/teams`, `/how-we-measure`, `/contact`)
plus the three legal ones and the docs:

| Route | Page | Focus |
|---|---|---|
| `/` | `pages/Home.tsx` | "Your team writes more code than it can review": the hero (with the Pending board), works with, the proof figures, the Review / Fix / Ship / See chapters, Why Limn, every feature free, questions and the close |
| `/reporting` | `pages/Reporting.tsx` | Reporting and metrics: the one window, period reports, Chronology, 26 weeks, where the work is happening, what bots are worth, This Sprint |
| `/teams` | `pages/Teams.tsx` | For teams: several teammates each running Limn, with GitHub as the go-between — team claims (one review per commit per provider), the author can't approve their own PR, one review across teammates, Waiting on others, what it never does, and the licence above the free size |
| `/how-we-measure` | `pages/HowWeMeasure.tsx` | The two ML models in plain English — what each is for, how it was built, how we know it works |
| `/contact` | `pages/Contact.tsx` | **Also the licence path** for organisations with more than three users, and where `/pricing` resolves. The only page that talks to a server (`POST /api/contact` → a Slack webhook) |
| `/docs` and `/docs/**` | `docs/DocsApp.tsx` + `docs/pages/**` | **The user documentation** (below): every screen of the app, AI review, AI Fix, Implement story, merging, every Settings tab, one page per integration, security, licence, FAQ, troubleshooting, the changelog |
| `/privacy` · `/cookies` · `/terms` | `pages/{Privacy,Cookies,Terms}.tsx` | Legal. Linked from the footer (on `/docs`, the one legal line at the bottom: there is no footer there) and the consent banner. Terms summarise the Limn License and defer to it |

**THE DESIGN IS ONE DARK "BOARD OF TILES"**, on every page. `src/board.css` holds the
tokens (the dark ground, the four pigments lapis / verdigris / madder / gold), the self-hosted
Albert Sans face, the shared header (`.lb-nav`) and footer (`.lb-foot`), and the tile grid; its
header comment lists the classes. Every page renders a root `<div className="lb <page>">`
with `useReveal` (`components/board/useReveal.ts`, which lifts `.rise` tiles in as they
scroll into view and leaves everything visible without JS) and keeps its own rules in a
page-scoped file under that root: `pages/reporting.css`, `teams.css`,
`how-we-measure.css`, `contact.css`, `legal.css`, and `components/chrome.css` for the 404, the
cookie banner and the lightbox. The home page's sections are `components/board/*` (layout in
`pages/home.css`).

**PRODUCT PICTURES ARE HTML MOCKS, NOT SCREENSHOTS** — on every page; the site holds no picture of the Limn UI. They are built from one kit,
`components/mock/` (`kit.tsx`: MockFrame, MockTabs, Segmented, Act, PrRow, Chip, FindingRow,
CheckRow, CourtBar, MiniTable, Diff, Log, Stat, and the settings controls Section / Field /
SelectBox / CheckLine / TextBox; the mocks themselves in `home.tsx`, `reports.tsx`, `teams.tsx`, and
`setup.tsx` for the docs' Getting started pages;
`mock.css` + `live.css`), and every word, number and state comes from ONE file,
`src/mock/acme.ts` (the fictional Acme team: PAY-142, #612, acme/payments …). Each mock is real
text with an `aria-label` summary and restacks under 961px.

**THE MOCKS ARE CLICKABLE.** A `live` MockFrame is `role="group"`; its tabs are a real tablist
(arrow keys, Home/End), its buttons run (Fix → diff → Push → "Pushed to …", Re-run failed jobs →
"Re-run requested.", Merge when ready → "Armed — merging when ready"), its rows open, and its
settings selects and checkboxes change what the section shows. The title bar says "Try it", then
"Reset" once something changed. The FIRST state is what the prerendered HTML shows, complete
without JS; the client's fresh `createRoot` render (no hydration) starts from the same state, and
adds the "Try it" hint only in the browser. A "working…" step lasts under a second and is skipped
under `prefers-reduced-motion`.

### The mocks mirror the app

When a user-visible change lands in `apps/frontend` that a mock shows (labels, tabs, chips,
flows), update `src/mock/acme.ts` and the mock in the same commit. Chip, tab and button words
are the app's own; never invent a feature for a mock.

| Mock (`components/mock/…`) | Page | Mirrors (`apps/frontend/src/…`) |
|---|---|---|
| `home.tsx` PendingBoardMock, PendingListMock | `/` hero, Review; `/teams` (PendingListMock opened on Waiting on others) | `components/Activity/AttentionView.tsx`, `pendingTabs.ts` (TAB_LABEL), `pendingLabels.ts`, `ReviewWaitActions.tsx` (Nudge), `PendingFlaky.tsx`, `PendingAiReviews.tsx` (AI reviews: the newest review per PR, New since the last look, then one "Seen …" block per earlier visit) |
| `home.tsx` ReviewMock (PR tabs) | `/` Review, `/teams` | `components/PrDetail.tsx` (TAB_LABELS), `ChecksTab.tsx` (the Overview's order), `pr/ReviewDecisionPill.tsx` ("Review required"), `ClaudeReviewTab.tsx`, `TeamReviewLayout.tsx` (Findings: Open, then "Resolved or addressed (n)"; who raised each), `lib/teamReview.ts` (`closedReason`), `ClaudeReviewFollowUp.tsx` `EarlierFindingNote` (an earlier finding's one-line how), `AiFixTab.tsx` |
| `home.tsx` StoryCheckMock | `/` Review | the story check in `ClaudeReviewTab.tsx` |
| `home.tsx` FixMock | `/` Fix | `components/AiFixTab.tsx`, `components/AiFix/`, `components/sandbox/SessionView.tsx` (Start fix, the session's tool rows, Push, Pushed to) |
| `home.tsx` CiMock | `/` Fix | `components/CheckList.tsx`, `Activity/PendingFlaky.tsx` (Re-run failed jobs) |
| `home.tsx` ConflictsMock | `/` Fix | `components/conflicts/` (`copy.ts`) |
| `home.tsx` VerdictMock | `/` Ship | `lib/ui.ts` `mergeVerdict`, the PR Overview's Blocked row |
| `home.tsx` MergeWhenReadyMock | `/` Ship | `components/MergeWhenReadyControl.tsx` |
| `home.tsx` TrunkMock | `/` Ship | the trunk strip (`/api/branch-status`) |
| `home.tsx` ChronologyMiniMock, BotsWorthMock | `/` See | `Activity/BottlenecksPanel.tsx`, Bots Monitoring |
| `teams.tsx` ClaimLinesMock | `/teams` | `components/CheckList.tsx` (the "Limn" label, "passed" / "running"), the `limn/review-*` line words (`review/claude-review/team-claim.ts`), `Activity/OpenPrsAiReview.tsx` ("Reviewed by @…"), `components/TeamClaimLine.tsx` |
| `teams.tsx` TeamStandingMock | `/teams` | `components/TeamReviewLayout.tsx` ("Where this PR stands"), `lib/teamReview.ts` (`standingLine`), `lib/claudeReviewColumn.ts` (`CLAUDE_VERDICT_LABEL`) |
| `reports.tsx` FlowMetricsMock | `/reporting` | `Activity/WorkspaceFlowMetrics`, `Activity/MetricsDetail.tsx` |
| `reports.tsx` PeriodReportMock | `/reporting` | `Activity/PeriodReportsPanel.tsx` + `PeriodSeriesChart.tsx` (Grain, Show as) |
| `reports.tsx` ChronologyMock, OverTimeMock | `/reporting` | `Activity/BottlenecksPanel.tsx` (the People + bots / People view in the meta line), `ChronologyTrend.tsx` (Show markers) |
| `reports.tsx` WhereWorkMock | `/reporting` | `charts/RepoRows` in `WorkspaceFlowMetrics` |
| `reports.tsx` BotsSeverityMock, BenchmarkMock | `/reporting`, `/how-we-measure` | Bots Monitoring (platform), the peer benchmark |
| `setup.tsx` AddReposMock | `/docs/getting-started/add-repositories` | `components/Activity/FirstRunOnboarding.tsx` |
| `setup.tsx` WorkspacesMock | `/docs/getting-started/workspaces` | `components/Activity/WorkspaceManager.tsx` |
| `reports.tsx` SprintLanesMock | `/reporting` | `Activity/SprintView.tsx`, `SprintBoards.tsx`, `sprintRailModel.ts` |

**THE SITE WAS FIVE FEATURE-AREA PAGES** (`/features`, `/bots`, `/pro`, `/pricing`,
`/how-it-works`) plus an arcade game, and they were removed together. The two role pages
that replaced them (For developers, For managers) were in turn replaced by Getting started
and Reporting and metrics, and Getting started then folded into the docs' Getting started
section (`/docs/getting-started/…`). Organising by feature
area meant a developer and an engineering manager read the same five pages and neither found
the half addressed to them.

⚠ **`pnpm dev` here needs the site service for the contact form.** Vite proxies `/api` to
`http://127.0.0.1:4300` (`LANDING_API_TARGET` overrides it) — run
`pnpm --filter @pierre-review/site dev` beside it. Without the proxy a bare
`fetch('/api/contact/ticket')` hits Vite's SPA fallback — 200, with HTML — and the form reads
that as "not configured" and renders its unavailable state, which looks exactly like a working
failure path rather than a missing server.

⚠ **The old URLs are aliased, not deleted.** `App.tsx` maps each of them to whichever page
now carries its content — `/pricing` to `/contact`, `/how-it-works` to `/how-we-measure`, `/for-managers`, `/bots`, `/pro`, `/insights` and `/reviews` to `/reporting` — and the header's `ALIAS_OF` (`components/Nav.tsx`) marks the matching link — and `prerender.mjs` writes the same mapping to disk so an old
inbound link gets real HTML with a canonical pointing at the surviving page. Change both
tables together.

⚠ **`/getting-started` is a 301, not an alias.** The page was folded into the docs, so
`apps/site` (`src/app.ts` `MOVED_TO_DOCS`) answers `/getting-started`, `/for-developers` and
`/features` with a permanent redirect to `/docs/getting-started/install-and-run`, before the
landing loads. `App.tsx` keeps the same table (`MOVED_TO_DOCS`) for `vite dev`, where no site
server stands in front. Change both together. `prerender.mjs` also writes `dist/404.html`, which `apps/site` serves with a
404 status for any unknown path.

- **Routing** (`src/router.tsx`): a ~80-line client router (`useRoute`, `navigate`, `Link`)
  — no router dependency. `apps/site` serves each route's prerendered page, so deep-links /
  reloads of every route work. `Link` full-navigates API/external URLs and
  client-routes the rest.
- **Shared UI**: `Nav.tsx` is the sticky header + mobile drawer; `Footer.tsx` the site
  footer (every page but `/docs`, which ends on its own legal line); `legal.tsx` the shell the three legal pages share; `CookieBanner.tsx` the consent
  banner.
- **Per-page SEO** (`src/lib/seo.ts`): `useSeo({ title, description, path })` sets the
  document title, meta description, canonical and Open Graph / Twitter tags on mount.
  Home-page defaults + JSON-LD live in `index.html`. `public/sitemap.xml` + `public/robots.txt`
  list the routes. Update the sitemap when routes change.

Everything is mobile-first; the app itself is desktop-only today (called out on the site),
so the marketing pages are the phone-friendly surface.

## The docs (`/docs`)

The user documentation lives in `src/docs/` (its own chunk: the marketing pages never load it).
**How to write and keep it current: [`src/docs/CONTRIBUTING.md`](src/docs/CONTRIBUTING.md).**
The rule: a user-visible change updates its docs page and `CHANGELOG.md`'s Unreleased in the same
commit; a removed feature removes its docs.

- **One file per page**, `src/docs/pages/<section>/<slug>.tsx` (`meta` + a hook-free body), listed
  in reading order in ONE manifest, `src/docs/manifest.ts`, which also maps the app's sidebar
  destinations, pull request tabs, Settings tabs, Pending / Reports / Bots Monitoring tabs to their
  pages (`APP_COVERAGE`).
- **The layout** (`DocsApp.tsx`, `docs.css`): a left-hand contents list whose sections stay
  collapsed until pressed (the current section opens by itself), a drawer below 961px, search over
  titles and summaries, breadcrumbs, "On this page", previous / next, "Edit this page" and
  "Report a problem". The header shows the current Limn version (`apps/backend/package.json`,
  read at build time) and links to the changelog.
- **The changelog** (`/docs/changelog`) is `CHANGELOG.md` at the repository root, parsed at build
  time. The release workflow moves its Unreleased entries under the new version
  (`docs/RELEASE.md` § The changelog), and `deploy-site.yml` rebuilds the site after every release.
- **Pictures are HTML mocks** from `src/docs/kit.tsx` (which re-exports the mock kit below), never
  screenshots.
- **Prerendered**: `prerender.mjs` writes every docs route with its own title and description, and
  adds each to `dist/sitemap.xml`.
- **Tested**: `test/docs.test.ts` (`pnpm --filter @pierre-review/landing test`, run by CI, the
  release and the site deploy).

The docs sections mirror the app:

| Docs section | The app (`apps/frontend/src/…`) |
|---|---|
| Open pull requests, Pending, This Sprint, Timeline, Docs library, Feed, Reports, Bots Monitoring | the sidebar's destinations (`components/shell/nav.ts` `DESTINATIONS`), each area's tabs |
| The pull request view | `components/PrDetail.tsx` `TAB_LABELS` (one page per tab) |
| Settings | `components/settings/settingsTabs.ts` `SETTINGS_TABS` (one page per tab) |
| AI review, Story checks, AI Fix, Implement story, Merging | the AI Review / AI Fix / Ticket tabs, the story view, the merge controls and the conflict resolver |
| Integrations | one page per vendor: GitHub, Claude, Codex, Jira, GitHub Issues, Linear, Notion, Confluence, SonarCloud, Slack, Docker and microsandbox |

## Google Analytics (fill in later)

GA4 is wired but silent until you provide a Measurement ID (`G-XXXXXXXXXX`). Either:

- set `VITE_GA_ID` at build time (e.g. `apps/landing/.env` → `VITE_GA_ID=G-XXXXXXXXXX`), or
- paste it into `GA_MEASUREMENT_ID` in `src/lib/analytics.ts`.

While empty, gtag.js is never loaded and nothing is tracked. Once set, `initAnalytics()`
(called from `App.tsx` on mount, and only with a stored consent grant) loads gtag and `trackPageView()` fires a page_view on every
client-side route change (`App.tsx`).

## Favicons

Generated from the brand mark into `public/` (`favicon-16/32/48.png`,
`apple-touch-icon.png`, `icon-192/512.png`, referenced from `index.html` +
`site.webmanifest`). To regenerate from a new source image with `sips`:

```sh
sips -c 130 130 logo.png --out /tmp/sq.png            # crop to a centred square
for s in 16 32 48 180 192 512; do sips -z $s $s /tmp/sq.png --out public/icon-$s.png; done
# then rename: favicon-16/32/48.png, apple-touch-icon.png (180), icon-192/512.png
```

## Screenshots

The pages use no screenshots at all (see the mocks above). `public/shots/` stays only because
`pnpm shots` (`scripts/capture-shots.mjs`, `scripts/demo-stack.mjs`) writes it and the repository
README embeds three of those shots, filmed on the fictional `acme/*` stack, never real GitHub data.
The walkthrough clip and its pipeline are gone.

## Reading the copy

`node scripts/dump-copy.mjs [out.md]` writes every word the site renders — in page
order, with the per-route `<title>` and meta description — to one markdown file, for
proofreading. It reads `apps/landing/dist`, so **build first**; what comes out is what a
reader actually gets rather than a hand transcription that drifts from it.

`scripts/capture-landing.mjs` screenshots the built landing pages at desktop + mobile widths
(into `scripts/.ui-artifacts/landing/`) and reports horizontal-overflow — handy for checking
responsive regressions.

## Commands

`pnpm --filter @pierre-review/landing {dev,build,preview,typecheck,test}` — dev server on `:5174`;
`test` is the docs test.
