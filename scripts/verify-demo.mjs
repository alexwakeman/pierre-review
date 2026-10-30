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
//   node scripts/verify-demo.mjs --only=pr:113   one view (substring match)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.VERIFY_PORT ?? 4391);
const BASE = `http://127.0.0.1:${PORT}/demo/`;
const SHOTS = '/tmp/limn-demo-shots';
const args = process.argv.slice(2);
const LATER_DAYS = Number(args.find((a) => a.startsWith('--later='))?.slice(8) ?? 0);
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7);
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
  ...['my_turn', 'claude', 'fixing', 'review', 'threads', 'land', 'deps'].map((t) => [`pending:${t}`, `?view=activity&activityRepo=attention&attnTab=${t}`, t === 'my_turn' ? 'pending' : t === 'deps' ? 'pending-deps' : null]),
  ['feed', '?view=activity&activityRepo=feed', 'feed'],
  ...['roi', 'themes', 'benchmark', 'classification'].map((t) => [`bots:${t}`, `?view=activity&activityRepo=bots&botsTab=${t}`, t === 'roi' ? 'bots-roi' : t === 'themes' ? 'bots-themes' : t === 'classification' ? 'bot-classification' : null]),
  ['bot-detail:8', '?view=bot-detail:8', null],
  ...['overview', 'bottlenecks', 'stories'].map((t) => [`reports:${t}`, `?view=activity&activityRepo=insights&insightsTab=${t}`, t === 'overview' ? 'reports' : t === 'bottlenecks' ? 'chronology' : null]),
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
  ['ticket:INFRA-260', `?view=${ident('INFRA-260')}`, null],
  // "Implement story" (docs/STORY-BUILD.md): the sprint board's entry points (the Implement button on a
  // not-started ticket with no session, the build marks on the two with one), the ready two-repository
  // build (acme/api pushed as a draft, acme/web-app ready with a failing check), the plan waiting for
  // Accept with its design, chat and docs, and the start state of a ticket with no session.
  [
    'sprint:implement',
    '?view=sprint&sprintTab=themes',
    null,
    {
      act: async (page) => {
        // The corner build button is revealed on hover; attached is what counts.
        await page.locator('[aria-label="Implement PLAT-318"]').first().waitFor({ state: 'attached', timeout: 10_000 });
        await page.locator('[aria-label="Open PLAT-310\'s build: Ready to push"]').first().waitFor({ state: 'attached', timeout: 10_000 });
        await page.locator('[aria-label="Open PLAT-312\'s build: Plan ready"]').first().waitFor({ state: 'attached', timeout: 10_000 });
      },
      expect: ['Ready to push', 'Plan ready'],
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
      ],
    },
  ],
  ['story-build:PLAT-318', `?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#PLAT-318')}`, null, { expect: ['Draw a design', 'Start'] }],
  ['timeline', '?view=timeline&preset=30d', 'timeline'],
  ...[113, 114, 105, 116].flatMap((id) =>
    ['overview', 'comments', 'changes', 'claude_review', 'ai_fix'].map((t) => [
      `pr:${id}:${t}`,
      `?view=pr-detail:${id}&prTab=${t}`,
      id === 113 ? `pr-113-${t}` : id === 114 && (t === 'ai_fix' || t === 'claude_review') ? `pr-114-${t}` : id === 105 && t === 'claude_review' ? 'pr-105-claude_review' : null,
      // #105 holds a Claude Opus review and a Codex GPT-6.1 Sol review of the same head, each labelled,
      // both options of the history select ("Showing"). The model menu lists BOTH providers (both
      // signed in): picking Codex's model leaves every run listed.
      id === 105 && t === 'claude_review'
        ? {
            act: async (page) => {
              // "Model" and "Showing" are the redesign's custom Select (role="combobox"): open it
              // and click the option by its words; its options exist only while it is open.
              await page.getByLabel('Model').first().click();
              await page.getByRole('option', { name: /^Codex · GPT-6\.1 Sol/ }).first().click();
              const history = page.getByLabel('Showing').first();
              await history.waitFor({ timeout: 10_000 });
              // Read the history's labels with it open. Both ran at Effort = High, and each label
              // says so.
              await history.click();
              const listId = await history.getAttribute('aria-controls');
              const labels = await page.locator(`[id="${listId}"] [role="option"]`).allTextContents();
              await page.keyboard.press('Escape');
              const want = ['Codex · GPT-6.1 Sol · high', 'Claude Opus 5.5 · high'];
              const absent = want.filter((w) => !labels.some((l) => l.includes(w)));
              if (labels.length !== 2 || absent.length > 0) {
                throw new Error(`history select: ${JSON.stringify(labels)} (want 2 options with ${JSON.stringify(want)})`);
              }
            },
            expect: ['Showing'],
          }
        : // #113's latest run read acme/infrastructure's branch of the same name (a related repo).
          id === 113 && t === 'claude_review'
          ? { expect: ['Also read: acme/infrastructure @ PLAT-292-upsert-transaction-boundaries'] }
          : undefined,
    ]),
  ),
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
    { act: openSettingsTab('AI'), expect: ['Default: Claude.', 'Automatic runs and default:', 'Signed in with ChatGPT Plus.', 'Effort for AI Review and AI Fix:', 'Repositories 1.3 GB · 1 checkout (184 MB) · 2.4 GB freed in 30 days'] },
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
      expect: ['Effort for AI Review and AI Fix:'],
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
  // Settings → Dependencies: merge, approve and resolve conflicts, the policy, and Dependabot trusted.
  [
    'settings:dependencies',
    '?view=activity',
    'settings-dependencies',
    {
      act: openSettingsTab('Dependencies'),
      expect: ['Dependency updates', 'Approve them automatically', 'Resolve their conflicts', 'Patch and minor updates', 'Trusted bots', 'Dependabot'],
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
      expect: ['Approved', 'Asked to rebase', 'Resolved conflicts'],
    },
  ],
  // Settings → AI review → Related repos: the seeded pair (acme/api with acme/infrastructure).
  [
    'settings:related-repos',
    '?view=activity',
    null,
    { act: openSettingsTab('AI review'), expect: ['Related repos', 'Reviewed together with', 'acme/api and acme/infrastructure'] },
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

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(
    PHONE
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' }
      : { viewport: { width: 1440, height: 950 }, colorScheme: 'dark', reducedMotion: 'reduce' },
  );
  await context.addInitScript(() => localStorage.setItem('pierre:onboarded', '1'));
  const page = await context.newPage();
  if (LATER_DAYS > 0) await page.clock.install({ time: new Date(Date.now() + LATER_DAYS * 86_400_000) });
  const failures = [];
  const shots = [];
  let pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  for (const [name, query, shot, opts] of VIEWS) {
    if (ONLY && !name.includes(ONLY)) continue;
    pageErrors = [];
    await page.goto(`${BASE}${query}`, { waitUntil: 'load' });
    // The app mounts once the recording is loaded; then let the in-browser API answer and the view
    // settle (recorded streams replay over a few seconds).
    await page.waitForFunction(() => document.body.innerText.trim().length > 300, null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1800);
    // A lazy tab (AI Review, AI Fix, Bot activity) shows a bare "Loading…" until its chunk arrives;
    // the first such view of a run could be read before it did (a flaky "text not shown").
    await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    const problems = [];
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
    console.log(`${problems.length ? '✗' : '✓'} ${name}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
    if (problems.length) failures.push(name);
    // A fresh log per view.
    await page.evaluate(() => {
      if (window.__limnDemo) window.__limnDemo.log.length = 0;
    });
  }
  await browser.close();
  stopSite();
  console.log(`\n${failures.length === 0 ? '✅' : '⚠'} ${VIEWS.length - failures.length} of ${VIEWS.length} views clean${LATER_DAYS ? ` (as if ${LATER_DAYS} days later)` : ''}${PHONE ? ' at 390px' : ''}`);
  console.log(`screenshots (${shots.length}): ${SHOTS_DIR}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
