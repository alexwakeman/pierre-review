// THE STATIC DEMO'S SMOKE PASS — `pnpm demo:verify` (after `pnpm --filter @pierre-review/frontend
// build:demo`). Serves apps/frontend/dist-demo at /demo/ through the real site server
// (apps/site), opens every view of the demo in Chromium and checks, per view:
//   • no uncaught page error;
//   • the page is not blank (the SPA has no error boundary: a render throw unmounts everything);
//   • `window.__limnDemo.log` has no 'missing' entry — a request the recording could not answer;
//   • where the row lists `expect`, that text is on the page (after the row's `act`, if any).
// Screenshots of the key views land in /tmp/limn-demo-shots/.
//
//   node scripts/verify-demo.mjs                 every view, as if opened now
//   node scripts/verify-demo.mjs --later=40      …as if opened 40 days after the recording
//   node scripts/verify-demo.mjs --only=pr:113   some views (comma list; substring, or a `*` glob)
//   --concurrency=<n>   views at once, each in its own fresh browser context (default 4)
//   --port=<p>          the site server's port (default 4391, or VERIFY_PORT)
//   --shots=<dir>       where screenshots go (default /tmp/limn-demo-shots; `-390` appended on --phone)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
};
const PORT = Number(argValue('port') ?? process.env.VERIFY_PORT ?? 4391);
const CONCURRENCY = Math.max(1, Number(argValue('concurrency') ?? 4));
const BASE = `http://127.0.0.1:${PORT}/demo/`;
// `--shots=<dir>` (or VERIFY_SHOTS_DIR): so two runs at once do not overwrite each other's screenshots.
const SHOTS = argValue('shots') ?? process.env.VERIFY_SHOTS_DIR ?? '/tmp/limn-demo-shots';
const LATER_DAYS = Number(argValue('later') ?? 0);
const ONLY = argValue('only')
  ?.split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => (p.includes('*') ? new RegExp(`^${p.replace(/[.+?^$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '.*')}$`) : p));
const selected = (name) => !ONLY || ONLY.some((p) => (typeof p === 'string' ? name.includes(p) : p.test(name)));
// `--phone`: the same views at 390 × 844 on a touch screen (mobile is a first-class target,
// docs/redesign/DESIGN.md § 6). Screenshots go to their own folder.
const PHONE = args.includes('--phone');
const SHOTS_DIR = PHONE ? `${SHOTS}-390` : SHOTS;
mkdirSync(SHOTS_DIR, { recursive: true });

const ident = (k) => encodeURIComponent(`ticket:jira:https://acme.atlassian.net#${k}`);
const story = (k) => encodeURIComponent(`jira:https://acme.atlassian.net#${k}`);

/** Open Settings from the account menu (the modal has no URL of its own). */
async function openSettings(page) {
  // Below lg the account button lives in the sidebar DRAWER: open it first.
  const account = page.locator('button[title^="Signed in as"]').first();
  if (!(await account.isVisible())) await page.locator('[data-testid=topbar-menu]').click();
  await account.click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).or(page.locator('[aria-label="Settings"]')).first().waitFor({ timeout: 10_000 });
}

/** Open Settings at one of its tabs (one area shows at a time; the rest are hidden). */
const openSettingsTab = (tab) => async (page) => {
  await openSettings(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  // On a phone each area's tab carries its one-line summary under the name, so match the name line.
  await (PHONE
    ? dialog.getByRole('tab').filter({ has: page.getByText(tab, { exact: true }) }).first()
    : dialog.getByRole('tab', { name: tab, exact: true })
  ).click();
};

/**
 * [name, query, screenshot?, { act?, expect? }] — `act(page)` runs after the view settles (a click
 * the view hides behind, never a URL); `expect` lists text the page must then show.
 */
const VIEWS = [
  ['open-prs', '?view=activity', 'open-prs'],
  // Open PRs → Merged (it was This Sprint's "Merged so far"; the old link lands here).
  [
    'open-prs:merged',
    '?view=activity&openPrsTab=merged',
    'open-prs-merged',
    { act: async (page) => page.getByTestId('merged-prs-view').first().waitFor({ timeout: 10_000 }) },
  ],
  ['open-prs:merged-legacy-link', '?view=sprint&sprintTab=merged', null, { act: async (page) => page.getByTestId('merged-prs-view').first().waitFor({ timeout: 10_000 }) }],
  // A row pressed docks the drawer; the rows beside it go to two lines (title, then repo · author · age).
  [
    'open-prs:drawer',
    '?view=activity',
    'open-prs-drawer',
    {
      act: async (page) => {
        await page.locator('main [role="option"]').first().click();
        await page.getByTestId('open-prs-row-two-line').first().waitFor({ timeout: 10_000 });
      },
    },
  ],
  // THE NEWEST REVIEW LEADS (docs/CLAUDE-REVIEW.md § Teammates' reviews): Priya's posted review on #114
  // is newer than Morgan's own run, so the Open PRs drawer shows hers, attributed.
  [
    'open-prs:teammate-lead',
    '?view=activity',
    null,
    {
      act: async (page) => {
        await page.locator('main [role="option"]', { hasText: 'right-size the EKS' }).first().click();
        await page.getByTestId('open-prs-panel-ai-review').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Priya · Request changes'],
    },
  ],
  // …and a Pending card: Lena's posted review is the only one on #141 (Morgan never ran his).
  [
    'pending:teammate-lead',
    '?view=activity&activityRepo=attention&attnTab=my_turn',
    null,
    {
      act: async (page) => {
        await page.getByTestId('activity-overlay').getByText('Migrate the sync scheduler to a job queue').first().click();
      },
      expect: ['Lena · Comment'],
    },
  ],
  // The header's daily auto-review limit toast: Platform's limit is today's count
  // (seed-demo-platform.ts), so it reads "reached" with "Change limit".
  [
    'auto-review-cap',
    '?view=activity',
    'auto-review-cap',
    {
      act: async (page) => {
        await page.getByTestId('header-toast-cluster').click();
        await page.getByTestId('auto-review-cap-toast-panel').waitFor({ timeout: 10_000 });
      },
      expect: ['Change limit'],
    },
  ],
  // The sidebar's open tabs grouped by author: the reader's own PR (#106) first, then Priya, then Sam.
  [
    'sidebar:tabs-by-author',
    '?view=pr-detail:106&prTab=overview',
    'sidebar-tabs-by-author',
    {
      act: async (page) => {
        for (const id of [113, 111]) {
          await page.goto(new URL(`?view=pr-detail:${id}&prTab=overview`, page.url()).href);
          await page.getByTestId('pinned-pr-overlay').first().waitFor({ timeout: 15_000 }).catch(() => {});
        }
        if (PHONE) await page.locator('[data-testid=topbar-menu]').click();
        await page.getByTestId('sidebar-tabs-by-author').first().click();
        const groups = await page.getByTestId('sidebar-tab-group').allTextContents();
        const want = ['Morgan Diaz', 'Priya Nair', 'Sam Carter'];
        if (groups.length < 3 || !want.every((w, i) => (groups[i] ?? '').startsWith(w))) {
          throw new Error(`tab groups: ${JSON.stringify(groups)} (want ${JSON.stringify(want)} first)`);
        }
      },
    },
  ],
  // A repo's own view: the status panel spells out its sidebar dots — red (a review waiting for you,
  // merge conflicts) and blue (new since you last opened #111 and #113; seed-demo.ts pr_views).
  [
    'repo:api',
    '?view=activity&activityRepo=2',
    'repo-status',
    { expect: ['Status', '1 pull request is waiting for your review', '1 pull request has merge conflicts', 'on 2 pull requests since you last opened them', 'Mark all seen'] },
  ],
  ...['my_turn', 'claude', 'fixing', 'review', 'threads', 'land', 'deps'].map((t) => [`pending:${t}`, `?view=activity&activityRepo=attention&attnTab=${t}`, t === 'my_turn' ? 'pending' : t === 'deps' ? 'pending-deps' : null]),
  ['feed', '?view=activity&activityRepo=feed', 'feed'],
  // Bots Monitoring's classification is Settings → Bots now (`settings:bots` below).
  ...['roi', 'themes', 'benchmark'].map((t) => [`bots:${t}`, `?view=activity&activityRepo=bots&botsTab=${t}`, t === 'roi' ? 'bots-roi' : t === 'themes' ? 'bots-themes' : null]),
  ['bot-detail:8', '?view=bot-detail:8', null],
  // A Limn finding is a bot comment, one bot per poster (docs/CLAUDE-REVIEW.md § Limn findings are bots).
  ['bots:roi:limn', '?view=activity&activityRepo=bots&botsTab=roi', null, { expect: ['Limn · morgan-diaz', 'Limn · priya-nair'] }],
  ['bot-detail:40', '?view=bot-detail:40', null],
  ['bot-detail:41', '?view=bot-detail:41', null],
  ...['overview', 'bottlenecks', 'stories'].map((t) => [`reports:${t}`, `?view=activity&activityRepo=insights&insightsTab=${t}`, t === 'overview' ? 'reports' : t === 'bottlenecks' ? 'chronology' : null]),
  // Chronology → Over time: a marker on "Working hours saved" opens what happened that week
  // (docs/BOTTLENECKS.md § Over time), floated over the page and never clipped by the chart above.
  [
    'reports:chronology-event',
    '?view=activity&activityRepo=insights&insightsTab=bottlenecks',
    'chronology-event',
    {
      act: async (page) => {
        const marker = page.getByTestId('chronology-trend').locator('button[aria-haspopup="dialog"][data-marker]').last();
        await marker.scrollIntoViewIfNeeded();
        await marker.click();
        await page.getByTestId('chronology-event-popover').waitFor({ timeout: 10_000 });
      },
      expect: ['Repository joined', 'acme/api joined the workspace', 'That week on this chart', 'Not counted until the week ends'],
    },
  ],
  ['reports:month', '?view=activity&activityRepo=insights&reportGrain=month', 'reports-month'],
  // Reports → AI usage: the ledger (scripts/seed-demo-ai-usage.ts), the 12 weeks and #116's auto re-reviews.
  [
    'reports:ai-usage',
    '?view=activity&activityRepo=insights&insightsTab=ai-usage',
    'reports-ai-usage',
    { expect: ['Where it goes', 'Top pull requests', 'Last 12 weeks', 'Ways to use fewer tokens', 'Auto review ran'] },
  ],
  // Two Confluence page trees beside the files (one current, one Confluence has stopped answering) and a
  // Notion page tree whose diagram Claude described (docs/REFERENCE-DOCS.md § Figures).
  [
    'docs',
    '?view=activity&activityRepo=docs',
    'docs',
    {
      // A document's facts and actions open with it (the row on show); a row that blocks says so regardless.
      act: async (page) => {
        await page.getByRole('button', { name: 'Checkout design notes', exact: true }).first().click();
        // A phone shows ONE pane: opening a document goes to Read; its row's facts are back on Library.
        if (PHONE) await page.getByRole('tab', { name: /^Library/ }).first().click();
        await page.getByText('1 figure described by AI').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Release handbook', 'Confluence · 3 pages', 'Can’t reach this page in Confluence since', 'Checkout design notes', 'Notion · 2 pages', '1 figure described by AI', 'On-call runbooks', 'GitHub · 3 pages'],
    },
  ],
  // DOCS SEARCH (docs/REFERENCE-DOCS.md § Search): the library's full-text search, one result with its
  // source, the section and the matched word.
  [
    'docs-search',
    '?view=activity&activityRepo=docs-search&docsQ=webhook',
    null,
    { expect: ['1 result', 'Platform API conventions', 'Webhooks', 'Relevance', 'Newest first', 'webhook signature'] },
  ],
  // THE DOCS OFFER (docs/REFERENCE-DOCS.md § Docs offered from your repositories): two folders found in
  // Platform's repositories, a checkbox each, and one too large to add in one go (seed-demo.ts).
  [
    'docs:offer',
    '?view=activity&activityRepo=docs',
    'docs-offer',
    {
      expect: [
        'Add 2 docs collections from your repositories?',
        'acme/api › docs',
        'acme/infrastructure › runbooks',
        'too large to add in one go',
        'Choose part of it',
        'Not now',
      ],
    },
  ],
  // The same offer as a card on Pending (every tab, until added or "Not now").
  ['pending:docs-offer', '?view=activity&activityRepo=attention', null, { expect: ['Add 2 docs collections from your repositories?', 'acme/api › docs'] }],
  // A document's "…" menu holds Refresh now, Rebuild and Remove (docs/REFERENCE-DOCS.md § The SPA).
  [
    'docs:menu',
    '?view=activity&activityRepo=docs',
    null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: 'More actions for Release handbook' }).first().click();
      },
      expect: ['Refresh now', 'Rebuild', 'Remove…'],
    },
  ],
  // THE ADD-DOCUMENTS WIZARD: a GitHub folder (its folders counted), and a whole Confluence space.
  [
    'docs:wizard-github',
    '?view=activity&activityRepo=docs',
    'docs-wizard',
    {
      act: async (page) => {
        if (PHONE) await page.getByRole('tab', { name: /^Library/ }).first().click();
        await page.getByRole('button', { name: 'Add documents' }).first().click();
        const wizard = page.getByTestId('docs-add-wizard');
        await wizard.getByText('GitHub repository', { exact: true }).first().click();
        await wizard.getByRole('button', { name: 'Next' }).click();
        await wizard.getByPlaceholder('owner/name').fill('acme/web');
        await wizard.getByRole('button', { name: 'Next' }).click();
        await wizard.getByText('docs/adr', { exact: true }).waitFor({ timeout: 10_000 });
        await wizard.getByText('docs', { exact: true }).first().click();
        await wizard.getByRole('button', { name: 'Next' }).click();
      },
      expect: ['This will add 11 documents from acme/web/docs.', 'Start'],
    },
  ],
  // "From your repositories": the docs offer's check over the workspace's repositories, a checkbox per
  // folder (a too-large one points at the GitHub source), then the review.
  [
    'docs:wizard-repos',
    '?view=activity&activityRepo=docs',
    null,
    {
      act: async (page) => {
        if (PHONE) await page.getByRole('tab', { name: /^Library/ }).first().click();
        await page.getByRole('button', { name: 'Add documents' }).first().click();
        const wizard = page.getByTestId('docs-add-wizard');
        await wizard.getByText('From your repositories', { exact: true }).first().click();
        await wizard.getByRole('button', { name: 'Next' }).click();
        await wizard.getByTestId('docs-wizard-repo-folders').waitFor({ timeout: 10_000 });
        await wizard.getByText('Choose part of it', { exact: true }).first().waitFor({ timeout: 10_000 });
        await wizard.getByText('acme/api › docs', { exact: true }).first().click();
        await wizard.getByRole('button', { name: 'Next' }).click();
      },
      expect: ['This will add 1 folder from your repositories as one document.', 'acme/api › docs', 'Add'],
    },
  ],
  [
    'docs:wizard-confluence',
    '?view=activity&activityRepo=docs',
    null,
    {
      act: async (page) => {
        if (PHONE) await page.getByRole('tab', { name: /^Library/ }).first().click();
        await page.getByRole('button', { name: 'Add documents' }).first().click();
        const wizard = page.getByTestId('docs-add-wizard');
        await wizard.getByText('Confluence', { exact: true }).first().click();
        await wizard.getByRole('button', { name: 'Next' }).click();
        await wizard.getByRole('button', { name: 'Next' }).click();
        await wizard.getByPlaceholder(/atlassian\.net/).fill('https://acme.atlassian.net/wiki/spaces/ENG/overview');
        await wizard.getByRole('button', { name: 'Next' }).click();
      },
      expect: ['This will add 42 pages from the whole Engineering wiki.', 'Read with your Jira connection.'],
    },
  ],
  ...['themes', 'paths', 'people', 'merged'].map((t) => [`sprint:${t}`, `?view=sprint&sprintTab=${t}`, t === 'themes' ? 'sprint-themes' : t === 'paths' ? 'sprint-paths' : null]),
  ['sprint:tray', `?view=sprint&sprintTab=themes&sprintStory=${story('PLAT-292')}`, 'sprint-tray'],
  ['ticket:PLAT-292', `?view=${ident('PLAT-292')}`, 'story-view'],
  // The ticket's comments (docs/TRACKERS.md § Ticket comments): a person's comment after the check is
  // counted in the story header; under "As written in Jira" the comments open, the Automation app's hidden.
  [
    'ticket:PLAT-292:comments',
    `?view=${ident('PLAT-292')}`,
    null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: /^As written in Jira/ }).first().click();
        await page.getByRole('button', { name: /^Comments \(2\)/ }).first().click();
      },
      expect: ['1 new comment since this check', 'Comments (2)', 'Lena Fischer', 'log its number'],
    },
  ],
  ['ticket:PLAT-301', `?view=${ident('PLAT-301')}`, null],
  // An unchanged story checked again (docs/REFERENCE-DOCS.md § Check a story against the docs): the
  // server reuses the last check, so the click answers at once with a line and a forced re-run.
  [
    'ticket:PLAT-301:docs-reuse',
    `?view=${ident('PLAT-301')}`,
    null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: 'Check docs again' }).first().click();
        // The heading's button is now the forced re-run.
        await page.getByRole('button', { name: 'Check again anyway' }).first().waitFor({ timeout: 10_000 });
      },
      expect: ['Nothing has changed since this check.', 'Check again anyway'],
    },
  ],
  // The story view's Ticket design: one data flow across both pull requests.
  ['ticket:INFRA-260', `?view=${ident('INFRA-260')}`, null, { expect: ['Terraform state moves to S3, guarded by a lock', 'a new state version'] }],
  // An unmet criterion's code in a member PR sits behind its label ("Code in"), not under the row.
  [
    'ticket:INFRA-260:unmet-code-in',
    `?view=${ident('INFRA-260')}`,
    null,
    {
      act: async (page) => {
        await page.locator('[data-criterion-ref] button', { hasText: /^AC3$/ }).first().click();
      },
      expect: ['Code in', 'scripts/migrate-state.sh:41'],
    },
  ],
  // "Implement story" (docs/STORY-BUILD.md § Entry points): the STORY VIEW's action — Implement on a
  // not-started ticket with no session, Fill gaps on a started one whose story check found gaps, Open
  // build on the two with a session — in This Sprint's tray (the board's cards carry only the build
  // MARKS) and in the story tab; then the ready two-repository build (acme/api pushed as a draft,
  // acme/web-app ready with a failing check), the plan waiting for Accept with its design, chat and
  // docs, and the start state of a ticket with no session.
  [
    'sprint:implement',
    `?view=sprint&sprintTab=themes&sprintStory=${story('PLAT-318')}`,
    'story-build-entry-tray',
    {
      act: async (page) => {
        await page.getByTestId('sprint-story-tray').locator('[aria-label="Implement PLAT-318"]').first().waitFor({ timeout: 10_000 });
        // No card carries a build button any more.
        if ((await page.locator('[data-testid="ticket-implement"]').count()) > 0) throw new Error('a sprint card still carries a build button');
      },
      // The board's build marks on the two tickets with a session.
      expect: ['Ready to push', 'Plan ready', 'Implement'],
    },
  ],
  [
    'sprint:fill-gaps',
    `?view=sprint&sprintTab=themes&sprintStory=${story('PLAT-301')}`,
    null,
    {
      act: async (page) => {
        await page.getByTestId('sprint-story-tray').locator('[aria-label="Fill gaps in PLAT-301"]').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Fill gaps'],
    },
  ],
  [
    'sprint:open-build',
    `?view=sprint&sprintTab=themes&sprintStory=${story('PLAT-310')}`,
    null,
    {
      act: async (page) => {
        await page.getByTestId('sprint-story-tray').locator('[aria-label="Open PLAT-310\'s build: Ready to push"]').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Open build'],
    },
  ],
  [
    'ticket:PLAT-312:open-build',
    `?view=${ident('PLAT-312')}`,
    null,
    {
      act: async (page) => {
        await page.locator('[aria-label="Open PLAT-312\'s build: Plan ready"]').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Open build'],
    },
  ],
  [
    'ticket:PLAT-318:implement',
    `?view=${ident('PLAT-318')}`,
    'story-build-entry-tab',
    {
      act: async (page) => {
        await page.locator('[aria-label="Implement PLAT-318"]').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Implement'],
    },
  ],
  [
    'story-build:PLAT-310',
    `?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#PLAT-310')}`,
    'story-build',
    { expect: ['Plan', 'Build', 'acme/api', 'acme/web-app', 'Pushed', 'Ready to push', 'Tests: 4 passed, 1 failed', 'pre-commit hook'] },
  ],
  [
    'story-build:PLAT-310:diff',
    `?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#PLAT-310')}`,
    null,
    {
      act: async (page) => {
        await page.locator('[data-testid="story-build-repo"][data-repo="acme/web-app"]').getByTestId('story-build-diff-toggle').click();
        await page.getByTestId('story-build-diff').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Paused until'],
    },
  ],
  [
    'story-build:PLAT-312',
    `?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#PLAT-312')}`,
    'story-build-plan',
    {
      expect: [
        'Accept plan and build',
        'acme/api',
        'Leave the load balancer check alone.',
        'Suggestions from the docs (2)',
        'This story changes the docs (1)',
        'Grounded in the docs (2)',
        'aren’t in the plan yet',
        // The planned design is a data flow.
        'Sync health query',
        'oldest running sync and error count, one query',
      ],
    },
  ],
  ['story-build:PLAT-318', `?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#PLAT-318')}`, null, { expect: ['Draw a design', 'Start'] }],
  [
    'story-build:PLAT-301',
    `?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#PLAT-301')}`,
    'story-build-fill-gaps',
    { expect: ['Fill gaps', 'Gaps from the story check (2)', 'Not met', 'Partly met'] },
  ],
  ['timeline', '?view=timeline&preset=30d', 'timeline'],
  ...[113, 114, 105, 116].flatMap((id) =>
    ['overview', 'comments', 'changes', 'ai_review', 'ai_fix'].map((t) => [
      `pr:${id}:${t}`,
      `?view=pr-detail:${id}&prTab=${t}`,
      id === 113 ? `pr-113-${t}` : id === 114 && (t === 'ai_fix' || t === 'ai_review') ? `pr-114-${t}` : id === 105 && t === 'ai_review' ? 'pr-105-ai_review' : null,
      // #105 holds a Claude Opus review and a Codex GPT-6.1 Sol review of the same head, each labelled,
      // both options of the history select ("Showing"). The model menu lists BOTH providers (both
      // signed in): picking Codex's model leaves every run listed.
      id === 105 && t === 'ai_review'
        ? {
            act: async (page) => {
              // "Model" and "Showing" are the redesign's custom Select (role="combobox"): open it
              // and click the option by its words; its options exist only while it is open.
              await page.getByLabel('Model').first().click();
              await page.getByRole('option', { name: /^Codex · GPT-6\.1 Sol/ }).first().click();
              const history = page.getByLabel('Showing').first();
              await history.waitFor({ timeout: 10_000 });
              // Read the history's labels with it open. In the wide tab's right-hand column they
              // name the provider only (no commit, no model); on a phone, the full run label.
              await history.click();
              const listId = await history.getAttribute('aria-controls');
              const labels = await page.locator(`[id="${listId}"] [role="option"]`).allTextContents();
              await page.keyboard.press('Escape');
              const want = ['Codex', 'Claude'];
              const absent = want.filter((w) => !labels.some((l) => l.includes(w)));
              if (labels.length !== 2 || absent.length > 0) {
                throw new Error(`history select: ${JSON.stringify(labels)} (want 2 options with ${JSON.stringify(want)})`);
              }
            },
            expect: ['Showing'],
          }
        : // #113's latest run read acme/infrastructure's branch of the same name (a related repo), and its
          // Design is a data-flow sequence (numbered steps, the line key under it).
          id === 113 && t === 'ai_review'
          ? {
              expect: [
                'Sync writes one pull request per transaction',
                'PR, threads and events in one transaction',
                'Write: heavy line, where data is kept',
              ],
            }
          : // #114's change moves no data: the model declined, and the pane says why in one line.
            id === 114 && t === 'ai_review'
            ? { expect: ['No diagram: this change only resizes the node-group limits.'] }
            : undefined,
    ]),
  ),
  // The PR view's Story tab: #113 names PLAT-292, so the story view renders inside the PR, and the
  // old `?prTab=claude_review` link still opens AI Review.
  [
    'pr:113:story',
    '?view=pr-detail:113&prTab=story',
    'pr-113-story',
    { expect: ['Open ticket tab', 'PLAT-292', 'Write each pull request in one transaction during sync'] },
  ],
  // TEAMMATES' POSTED REVIEWS (docs/CLAUDE-REVIEW.md § Teammates' reviews → One review): Priya's Limn
  // review of #114 joins the one review — her still-open findings in Findings, named "Priya".
  [
    'pr:114:teammate-review',
    '?view=pr-detail:114&prTab=ai_review',
    'pr-114-teammate-review',
    { expect: ['Priya', 'max_size', 'worker_max_nodes', '2 Limn reviews so far · 1 by Priya', 'desired_size'] },
  ],
  // THE AI REVIEW ON THE PR OVERVIEW: #114's newest review is Priya's (posted after Morgan's run), so the
  // card names her; one of her open findings has no severity ("other"). #113's is Morgan's own.
  ['pr:114:overview-ai-review', '?view=pr-detail:114&prTab=overview', null, { expect: ['AI review', 'Priya', 'Open review'] }],
  ['pr:113:overview-ai-review', '?view=pr-detail:113&prTab=overview', null, { expect: ['AI review', 'Open review', '1 blocker'] }],
  // A legacy post (the bare marker): no model, the head inferred. Named "Lena".
  ['pr:141:teammate-review-legacy', '?view=pr-detail:141&prTab=ai_review', null, { expect: ['Lena'] }],
  // #111: Sam reviewed his own PR with Limn; Morgan's run follows up on it, under his name, with no
  // Post reply or Resolve on his threads.
  [
    'pr:111:author-review-follow-up',
    '?view=pr-detail:111&prTab=ai_review',
    'pr-111-ai_review',
    { expect: ['@sam-carter’s review', 'No frame when the sync ends'] },
  ],
  // The split button's menu: Review only / Review and post.
  [
    'pr:113:review-split-menu',
    '?view=pr-detail:113&prTab=ai_review',
    null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: 'Choose how to review' }).first().click();
      },
      expect: ['Review only', 'Review and post'],
    },
  ],
  ['pr:113:claude_review-alias', '?view=pr-detail:113&prTab=claude_review', null, { expect: ['Run a review'] }],
  // AI Fix "Run tests": #114's fix ran the project's checks in the sandbox (results + the commit
  // hook), and "New fix" → "Run tests" lists what the head declares, one refused by the deny scan.
  [
    'pr:114:ai_fix:run-tests',
    '?view=pr-detail:114&prTab=ai_fix',
    null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: 'New fix' }).first().click();
        await page.getByRole('checkbox', { name: 'Run tests' }).first().check();
        await page.getByText('test-integration', { exact: true }).first().waitFor({ timeout: 10_000 });
      },
      expect: ['The AI ran checks 2 times while it worked.', 'pre-commit hook', 'It starts or builds containers.'],
    },
  ],
  // The Changes tab's "Threads only" view (there is no Threads tab): the toggle on the sticky bar
  // swaps the code for the threads, each with a way back to its code.
  ...[113, 105].map((id) => [
    `pr:${id}:changes-threads`,
    `?view=pr-detail:${id}&prTab=changes`,
    id === 113 ? 'pr-113-changes-threads' : null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: /^Threads only/ }).first().click();
        await page.getByTestId('changes-threads-view').waitFor({ timeout: 10_000 });
      },
      expect: ['Threads only', 'Show in context'],
    },
  ]),
  // Settings → AI: Claude is the default (automatic runs, surfaces without a model menu); picking
  // Codex says so, and the usage item follows.
  [
    'settings:ai',
    '?view=activity',
    'settings-ai',
    // Disk space: the clone cache's one line (hand-written in the demo, demo/routes.ts).
    { act: openSettingsTab('AI'), expect: ['Default: Claude.', 'Automatic runs and default:', 'Signed in with ChatGPT Plus.', 'Effort for reviews and AI Fix:', 'Repositories 1.3 GB · 1 checkout (184 MB) · 2.4 GB freed in 30 days'] },
  ],
  // Settings → AI → Effort: a level is picked (simulated, provider.ts) and the control keeps it.
  [
    'settings:ai-effort',
    '?view=activity',
    'settings-ai-effort',
    {
      act: async (page) => {
        await openSettingsTab('AI')(page);
        // A custom Select (components/ui/Select.tsx), not a native one: open it, pick the option; its
        // hidden input carries the value.
        await page.locator('#ai-effort').click();
        await page.getByRole('option', { name: 'High', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('input[name="ai-effort"]')?.value === 'high', null, { timeout: 10_000 });
      },
      expect: ['Effort for reviews and AI Fix:'],
    },
  ],
  [
    'settings:ai-codex',
    '?view=activity',
    'settings-ai-codex',
    {
      act: async (page) => {
        await openSettingsTab('AI')(page);
        await page.locator('input[name="ai-provider"][value="codex"]').click();
        await page.getByText('Default: Codex.').waitFor({ timeout: 10_000 });
      },
      expect: ['Default: Codex.'],
    },
  ],
  // Settings → Bots: every bot with its category (it was Bots Monitoring → Classification).
  [
    'settings:bots',
    '?view=activity',
    'settings-bots',
    {
      act: async (page) => {
        await openSettingsTab('Bots')(page);
        await page.getByTestId('bot-classification-card').first().waitFor({ timeout: 10_000 });
      },
      expect: ['CodeRabbit'],
    },
  ],
  // Settings → Features: every destination switched on (the demo is an existing install).
  [
    'settings:features',
    '?view=activity',
    null,
    { act: openSettingsTab('Features'), expect: ['Choose which pages the sidebar shows.', 'This Sprint', 'Bots Monitoring'] },
  ],
  // Settings → Dependencies: merge, approve and resolve conflicts, the policy, and Dependabot trusted.
  [
    'settings:dependencies',
    '?view=activity',
    'settings-dependencies',
    {
      act: openSettingsTab('Dependencies'),
      expect: ['Dependency updates', 'Approve them automatically', 'Resolve their conflicts', 'Fix them with AI', 'Patch and minor updates', 'Trusted bots', 'Dependabot'],
    },
  ],
  // Pending → Dependencies → "What automation did": the seeded approval, rebase request and AI run.
  [
    'pending:deps-automation',
    '?view=activity&activityRepo=attention&attnTab=deps',
    null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: 'What automation did' }).first().click();
      },
      expect: ['Approved', 'Asked to rebase', 'Resolved conflicts', 'Fixed CI with AI', 'Couldn’t fix CI', 'Fixing CI with AI', 'Armed to merge', 'Merged', 'Priya Nair is handling this', 'Wei Zhang handled this'],
    },
  ],
  // Settings → AI review → Related repos: the seeded pair (acme/api with acme/infrastructure).
  [
    'settings:related-repos',
    '?view=activity',
    null,
    { act: openSettingsTab('AI review'), expect: ['Related repos', 'Select a repo, then click', 'Related to', 'infrastructure'] },
  ],
  // Settings → Docs → Confluence: the site and email saved, the token never shown; pages on the
  // demo's Jira site read with the Jira token.
  [
    'settings:confluence',
    '?view=activity',
    null,
    { act: openSettingsTab('Docs'), expect: ['Confluence', 'Pages on acme.atlassian.net use your Jira token.', 'Test connection'] },
  ],
  // Settings → Docs → Notion: a token saved (never shown), the sharing rule behind the ⓘ.
  [
    'settings:notion',
    '?view=activity',
    null,
    { act: openSettingsTab('Docs'), expect: ['Notion', 'Add Notion pages to Docs.', 'Integration token'] },
  ],
  ['user-activity:2', '?view=user-activity:2', null],
  ['ws2:open-prs', '?view=activity&workspace=2', null],
  // The Web workspace reads NOTION (docs/TRACKERS.md § Notion): the sprint from the Sprints database,
  // a ticket's story with its comments (the bot's hidden), and Settings → Integrations' mapping.
  ['ws2:sprint', '?view=sprint&workspace=2', null, { expect: ['Web Sprint 9'] }],
  // The Admin workspace's sprint is the CURRENT iteration of a GitHub Projects board.
  ['ws3:open-prs', '?view=activity&workspace=3', null],
  ['ws3:sprint', '?view=sprint&workspace=3', null, { expect: ['Sprint 14'] }],
  // Pending on the first landing (docs/FRONTEND.md): Admin's empty board lists Morgan's own PR and
  // what blocks it, under the one-time AI review suggestion; Platform's board carries the summary line.
  [
    'ws3:pending',
    '?view=activity&activityRepo=attention&workspace=3',
    null,
    { expect: ['Nothing here needs you right now.', 'Show who changed a role in the audit log', 'blocked', 'Review your PR #14 with'] },
  ],
  ['pending:summary', '?view=activity&activityRepo=attention', null, { expect: ['waiting on you', 'unanswered threads'] }],
  [
    'ticket:notion:WEB-34',
    `?view=${encodeURIComponent('ticket:notion:https://www.notion.so/5e1f0c2a7b3d4e8f9a0b1c2d3e4f5a6b#WEB-34')}&workspace=2`,
    null,
    {
      act: async (page) => {
        await page.getByRole('button', { name: /^As written in Notion/ }).first().click();
        await page.getByRole('button', { name: /^Comments \(2\)/ }).first().click();
      },
      expect: ['Move between open-PR cards with the keyboard', 'Comments (2)', 'Home and End are in'],
    },
  ],
  [
    'ws2:settings:notion',
    '?view=activity&workspace=2',
    null,
    {
      act: async (page) => {
        await openSettingsTab('Integrations')(page);
        await page.getByTestId('notion-read-database').first().click();
        await page.getByTestId('notion-mapping-form').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Database URL', 'Integration token', 'keys look like WEB-123', 'Sprint dates'],
    },
  ],
  ['ws2:chronology', '?view=activity&workspace=2&activityRepo=insights&insightsTab=bottlenecks', null],

  // ── Flaky checks (Web, #117: one check passed then failed on the same head) ──
  // The Pending card says "Flaky" and offers "Re-run failed jobs"; pressing it reads the PR's checks
  // and asks GitHub (simulated) to re-run the failed jobs.
  [
    'pending:flaky',
    '?view=activity&activityRepo=attention&attnTab=fixing&workspace=2',
    'pending-flaky',
    {
      act: async (page) => {
        await page.getByRole('option').filter({ hasText: 'web-app#117' }).first().click();
        await page.getByTestId('flaky-chip').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Flaky', 'e2e (playwright)', 'Re-run failed jobs'],
    },
  ],
  [
    'pending:flaky-rerun',
    '?view=activity&activityRepo=attention&attnTab=fixing&workspace=2',
    null,
    {
      act: async (page) => {
        await page.getByRole('option').filter({ hasText: 'web-app#117' }).first().click();
        await page.getByTestId('pending-panel').getByRole('button', { name: 'Re-run failed jobs' }).first().click();
        await page.getByText('Re-run requested.').first().waitFor({ timeout: 10_000 });
      },
    },
  ],
  ['pr:117:flaky', '?view=pr-detail:117&prTab=overview&workspace=2', 'pr-117-flaky', { expect: ['1 flaky'] }],

  // ── PR chips: a 3-PR stack on acme/api (#150 → #151 → #152), "Criteria n/m", "Large" (#153) ──
  ['open-prs:chips', '?view=activity', null, { expect: ['Criteria 3/3', 'Criteria 0/3'] }],
  ['pr:151:stack', '?view=pr-detail:151&prTab=overview', 'pr-151-stack', { expect: ['2 of 3 in stack', 'lands after #150'] }],
  ['pr:116:criteria', '?view=pr-detail:116&prTab=overview', null, { expect: ['Criteria 3/3'] }],
  ['pr:153:large', '?view=pr-detail:153&prTab=overview&workspace=2', 'pr-153-large', { expect: ['Large'] }],

  // ── Waiting on others (#118: Morgan's own PR, waiting on Wei and the platform team) ──
  [
    'pending:waiting',
    '?view=activity&activityRepo=attention&attnTab=waiting',
    'pending-waiting',
    {
      act: async (page) => {
        await page.getByRole('option').filter({ hasText: 'api#118' }).first().click();
        await page.getByTestId('pending-panel').getByRole('button', { name: 'Ask someone else' }).first().click();
        await page.getByTestId('ask-someone-else').first().waitFor({ timeout: 10_000 });
      },
      expect: ['Waiting on others', 'Over the 4h review target', 'Nudge', 'Ask @'],
    },
  ],
  // Nudge and "Ask someone else" each land: the button says so, and the PR's waits restart.
  [
    'pending:waiting-nudge',
    '?view=activity&activityRepo=attention&attnTab=waiting',
    null,
    {
      act: async (page) => {
        await page.getByRole('option').filter({ hasText: 'api#118' }).first().click();
        await page.getByTestId('pending-panel').getByRole('button', { name: /^Nudge / }).first().click();
        await page.getByText('Nudged').first().waitFor({ timeout: 10_000 });
      },
    },
  ],
  [
    'pr:118:ask-someone-else',
    '?view=pr-detail:118&prTab=overview',
    'pr-118-requested',
    {
      act: async (page) => {
        await page.getByRole('button', { name: 'Ask someone else' }).first().click();
        const ask = page.getByTestId('ask-someone-else').first();
        await ask.waitFor({ timeout: 10_000 });
        await ask.getByRole('button', { name: /^Ask @/ }).click();
        await page.getByText(/Asked @/).first().waitFor({ timeout: 10_000 });
      },
      // The person asked joins the Requested row by name, their wait starting now.
      expect: ['Over the 4h review target', 'Nudge', 'Sam Carter'],
    },
  ],
  [
    'pending:my-turn-review-target',
    '?view=activity&activityRepo=attention&attnTab=my_turn',
    null,
    {
      act: async (page) => page.getByRole('option').filter({ hasText: 'api#111' }).first().click(),
      expect: ['review target'],
    },
  ],
  ['reports:review-target', '?view=activity&activityRepo=insights&insightsTab=bottlenecks', 'chronology-review-target', { expect: ['Review target', 'of first reviews arrived within 4 working hours'] }],
];

async function main() {
  const site = spawn(join(ROOT, 'apps', 'site', 'node_modules', '.bin', 'tsx'), ['apps/site/src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DEMO_DIR: join(ROOT, 'apps', 'frontend', 'dist-demo') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const stopSite = () => {
    try {
      site.kill('SIGTERM');
    } catch {
      /* gone */
    }
  };
  process.on('exit', stopSite);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const views = VIEWS.filter(([name]) => selected(name));
  if (!views.length) {
    // A typo in --only must not read as a clean run.
    console.error(`no view matches --only=${argValue('only')}`);
    stopSite();
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true });
  const contextOptions = PHONE
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' }
    : { viewport: { width: 1440, height: 950 }, colorScheme: 'dark', reducedMotion: 'reduce' };
  const results = new Map(); // name → problems[]
  const shots = [];

  /** One view, in a fresh context: no state from another view (the demo's overlay, a picked setting). */
  async function check([name, query, shot, opts]) {
    const context = await browser.newContext(contextOptions);
    await context.addInitScript(() => localStorage.setItem('pierre:onboarded', '1'));
    const page = await context.newPage();
    if (LATER_DAYS > 0) await page.clock.install({ time: new Date(Date.now() + LATER_DAYS * 86_400_000) });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const problems = [];
    try {
      await page.goto(`${BASE}${query}`, { waitUntil: 'load' });
      // The app mounts once the recording is loaded; then let the in-browser API answer and the view
      // settle (recorded streams replay over a few seconds).
      await page.waitForFunction(() => document.body.innerText.trim().length > 300, null, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1800);
      // A lazy tab (AI Review, AI Fix, Bot activity) shows a bare "Loading…" until its chunk arrives;
      // the first such view of a run could be read before it did (a flaky "text not shown").
      await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
      if (opts?.act) {
        try {
          await opts.act(page);
          await page.waitForTimeout(800);
        } catch (e) {
          problems.push(`action failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
        }
      }
      const text = await page.evaluate(() => document.body.innerText.trim().length);
      const missing = await page.evaluate(() => {
        const d = window.__limnDemo;
        return d ? d.log.filter((e) => e.stage === 'missing').map((e) => `${e.method} ${e.url}`) : ['(no demo server)'];
      });
      if (opts?.expect) {
        const body = await page.evaluate(() => document.body.innerText);
        const absent = opts.expect.filter((t) => !body.includes(t));
        if (absent.length) problems.push(`text not shown: ${absent.map((t) => JSON.stringify(t)).join(', ')}`);
      }
      if (pageErrors.length) problems.push(`page errors: ${[...new Set(pageErrors)].join(' | ').slice(0, 300)}`);
      if (text < 200) problems.push(`nearly blank (${text} chars)`);
      if (missing.length) problems.push(`missing: ${[...new Set(missing)].join(', ').slice(0, 600)}`);
      if (shot) {
        const file = join(SHOTS_DIR, `${shot}.png`);
        await page.screenshot({ path: file });
        shots.push(file);
      }
    } catch (e) {
      problems.push(`failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
    } finally {
      await context.close();
    }
    results.set(name, problems);
    console.log(`${problems.length ? '✗' : '✓'} ${name}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
  }

  const queue = [...views];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let v = queue.shift(); v; v = queue.shift()) await check(v);
    }),
  );
  // In declared order, whatever order they finished in.
  const failures = views.map(([name]) => name).filter((name) => results.get(name)?.length);
  await browser.close();
  stopSite();
  if (failures.length) console.log(`\nfailed: ${failures.join(', ')}`);
  console.log(`\n${failures.length === 0 ? '✅' : '⚠'} ${views.length - failures.length} of ${views.length} views clean in ${Math.round((Date.now() - t0) / 1000)}s on ${Math.min(CONCURRENCY, views.length)} page${Math.min(CONCURRENCY, views.length) === 1 ? "" : "s"}${LATER_DAYS ? ` (as if ${LATER_DAYS} days later)` : ''}${PHONE ? ' at 390px' : ''}`);
  console.log(`screenshots (${shots.length}): ${SHOTS_DIR}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
