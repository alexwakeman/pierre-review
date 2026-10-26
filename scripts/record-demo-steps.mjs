// The recorder's walk through the SPA (scripts/record-demo.mjs). Each step navigates to a view and
// opens what that view hides behind a click, so every /api answer the demo needs is seen.
//
// ⚠ THE DEFAULT WORKSPACE (Platform, id 1) GOES FIRST: the demo answers a request whose exact query
// was never recorded with the FIRST entry recorded for its path.
// ⚠ NOTHING HERE WRITES. `h.explore()` clicks tabs and disclosures only, never a button whose label
// is a verb that changes something (merge, post, run, save …); every finished agentic run in the
// recording is a row the seeder wrote.

const PENDING_TABS = ['my_turn', 'claude', 'fixing', 'review', 'threads', 'land', 'deps'];
// Activity is a collapsed section of Overview now (opened below); Comments is its own tab.
const PR_TABS = ['overview', 'comments', 'changes', 'bot_activity', 'claude_review', 'ai_fix'];
const ROOT = 'https://acme.atlassian.net';
const ident = (key) => `jira:${ROOT}#${key}`;
const enc = encodeURIComponent;

// Every open PR the demo shows in depth, then a few others (merged, a dependency bump, the queued one).
const DEEP_PRS = [113, 114, 105, 116, 111];
const MORE_PRS = [141, 142, 104, 106, 2278, 2196, 2349, 2207, 2213];
const WEB_PRS = [101, 112, 140];
// EVERY sprint card, ghosts included: a card click opens its story in the tray, so a missing one
// reads "Couldn't load this story." in the demo.
const TICKETS = [
  'PLAT-292', 'PLAT-301', 'PLAT-288', 'PLAT-305', 'PLAT-312', 'PLAT-296', 'PLAT-297', 'PLAT-310', 'PLAT-315', 'PLAT-318',
  'INFRA-231', 'INFRA-244', 'INFRA-260', 'INFRA-248', 'INFRA-252', 'INFRA-199', 'INFRA-180',
];
const PEOPLE = [1, 2, 5, 6, 3];
const BOTS = [8, 9, 10, 20];

/** Expand everything a reader would expand on this view (tabs, disclosures), never a write. */
const explore = (h, opts) => h.explore(opts);

export const STEPS = [
  // ── Activity → Open PRs (the landing view) ──
  {
    name: 'open-prs',
    run: async (h) => {
      await h.go('?view=activity');
      await explore(h, { max: 12 });
    },
  },
  { name: 'repo-console', run: (h) => h.go('?view=activity&activityRepo=2') },

  // ── Pending: every tab, both lenses, a few kind chips ──
  ...PENDING_TABS.map((t) => ({
    name: `pending:${t}`,
    run: async (h) => {
      await h.go(`?view=activity&activityRepo=attention&attnTab=${t}`);
      await explore(h, { max: 8, scope: 'main' });
    },
  })),
  { name: 'pending:mine', run: (h) => h.go('?view=activity&activityRepo=attention&attnRel=mine') },
  { name: 'pending:others', run: (h) => h.go('?view=activity&activityRepo=attention&attnRel=others') },
  { name: 'pending:people', run: (h) => h.go('?view=activity&activityRepo=attention&attnBy=people') },
  { name: 'pending:automation', run: (h) => h.go('?view=activity&activityRepo=attention&attnBy=automation') },
  {
    name: 'pending:merge-controls',
    run: async (h) => {
      await h.go('?view=activity&activityRepo=attention&attnTab=land');
      // The merge control fetches its live options on click (GitHub stand-in answers).
      await h.clickAll(h.page.getByRole('button', { name: /^(Merge|Merge when ready)$/ }), { max: 3, after: () => h.escape() });
    },
  },

  // ── Feed ──
  {
    name: 'feed',
    run: async (h) => {
      await h.go('?view=activity&activityRepo=feed');
      await h.scroll();
      await h.clickRole('button', /^Bots$/);
      await h.scroll();
      await h.clickRole('button', /^People$/);
    },
  },
  { name: 'feed:isolated', run: (h) => h.go('?view=activity&activityRepo=feed&feedPr=113') },

  // ── Bots Monitoring ──
  ...['roi', 'themes', 'benchmark', 'classification'].map((t) => ({
    name: `bots:${t}`,
    run: async (h) => {
      await h.go(`?view=activity&activityRepo=bots&botsTab=${t}`);
      await explore(h, { max: 14, scope: 'main' });
    },
  })),
  {
    name: 'bots:drilldowns',
    run: async (h) => {
      const url = '?view=activity&activityRepo=bots&botsTab=roi';
      await h.go(url);
      for (const w of ['7d', '30d', 'Sprint', '14d']) await h.clickRole('button', new RegExp(`^${w}$`));
      // The flagging tiles, the two "Show list" banners and the first rows' figures each open a
      // drill-down (with its synthesis card).
      for (const label of ['FINDINGS', 'HIGH SEVERITY', 'NITS', 'TOP TOPIC', 'SAME-LINE OVERLAP']) {
        if (await h.click(h.page.getByText(label, { exact: true }))) {
          await h.scroll();
          await h.go(url);
        }
      }
      for (let i = 0; i < 2; i++) {
        if (await h.click(h.page.getByRole('button', { name: /Show list/ }).nth(i))) await h.go(url);
      }
      const cells = h.page.locator('main table tbody tr button, main table tbody tr a');
      const n = Math.min(10, await cells.count());
      for (let i = 0; i < n; i++) {
        if (await h.click(cells.nth(i))) {
          await h.scroll();
          await h.go(url);
        }
      }
    },
  },
  ...BOTS.map((id) => ({
    name: `bot-detail:${id}`,
    run: async (h) => {
      await h.go(`?view=bot-detail:${id}`);
      await explore(h, { max: 10, scope: 'main' });
    },
  })),

  // ── Reports ──
  ...['overview', 'bottlenecks', 'stories'].map((t) => ({
    name: `reports:${t}`,
    run: async (h) => {
      await h.go(`?view=activity&activityRepo=insights&insightsTab=${t}`);
      await explore(h, { max: 14, scope: 'main' });
      await h.selectAll('main select');
    },
  })),
  {
    name: 'reports:tiles',
    run: async (h) => {
      const url = '?view=activity&activityRepo=insights&insightsTab=overview';
      await h.go(url);
      const tiles = h.page.locator('main button:has-text("PRs"), main button:has-text("lead"), main button:has-text("review")');
      const n = Math.min(6, await tiles.count());
      for (let i = 0; i < n; i++) {
        if (await h.click(tiles.nth(i))) {
          await h.scroll();
          await h.go(url);
        }
      }
    },
  },
  {
    name: 'reports:periods',
    run: async (h) => {
      const list = await h.fetchGet('/api/pro/insights/reports?workspace=1');
      const keys = (list?.periods ?? []).map((r) => r.periodKey).filter(Boolean);
      for (const k of keys.slice(-6)) await h.go(`?view=activity&activityRepo=insights&report=${enc(k)}`);
      await h.go('?view=activity&activityRepo=insights&reportGrain=month');
      const months = await h.fetchGet('/api/pro/insights/reports?grain=month&workspace=1');
      const mkeys = (months?.periods ?? []).map((r) => r.periodKey).filter(Boolean);
      for (const k of mkeys) await h.go(`?view=activity&activityRepo=insights&reportGrain=month&report=${enc(k)}`);
    },
  },

  // ── Docs ──
  {
    name: 'docs',
    run: async (h) => {
      await h.go('?view=activity&activityRepo=docs');
      await explore(h, { max: 16, scope: 'main' });
      // Every built section, its contents page and the conversation, by the paths the viewer asks.
      const docs = await h.fetchGet('/api/docs?workspace=1');
      const paths = new Set(['INDEX.md']);
      const collect = (v) => {
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (k === 'path' && typeof x === 'string' && x.endsWith('.md')) paths.add(x);
            else collect(x);
          }
        }
      };
      collect(await h.fetchGet('/api/docs/tree?workspace=1'));
      for (const d of docs?.docs ?? []) {
        collect(await h.fetchGet(`/api/docs/tree?docId=${d.id}&workspace=1`));
        paths.add(`${d.slug}/CONTENTS.md`);
      }
      for (const p of paths) await h.fetchGet(`/api/docs/section?path=${enc(p)}&workspace=1`);
      const chats = await h.fetchGet('/api/docs/chats?workspace=1');
      for (const c of chats?.conversations ?? []) await h.fetchGet(`/api/docs/chats/${enc(c.conversationId ?? c.id)}?workspace=1`);
      await h.fetchGet('/api/workspaces/1/docs-settings');
    },
  },

  // ── This Sprint ──
  ...['themes', 'paths', 'people', 'merged'].map((t) => ({
    name: `sprint:${t}`,
    run: async (h) => {
      await h.go(`?view=sprint&sprintTab=${t}`);
      await explore(h, { max: 6, scope: 'main' });
    },
  })),
  ...TICKETS.slice(0, 8).map((k) => ({
    name: `sprint:tray:${k}`,
    run: (h) => h.go(`?view=sprint&sprintTab=themes&sprintStory=${enc(ident(k))}`),
  })),

  // ── Ticket (story) tabs ──
  ...TICKETS.map((k) => ({
    name: `ticket:${k}`,
    run: async (h) => {
      await h.go(`?view=${enc(`ticket:${ident(k)}`)}`);
      await explore(h, { max: 10, scope: 'main' });
    },
  })),

  // ── Timeline ──
  { name: 'timeline', run: (h) => h.go('?view=timeline&preset=30d') },
  { name: 'timeline:7d', run: (h) => h.go('?view=timeline&preset=7d') },
  { name: 'timeline:focus', run: (h) => h.go('?view=pr-focus:113') },

  // ── PR detail: every tab of the main PRs, the overview of the rest ──
  ...DEEP_PRS.flatMap((id) =>
    PR_TABS.map((t) => ({
      name: `pr:${id}:${t}`,
      run: async (h) => {
        await h.go(`?view=pr-detail:${id}&prTab=${t}`);
        if (t === 'overview') {
          await h.clickRole('button', /^Show actions$/);
          // Checks and Activity arrive collapsed: open both so the per-check logs get recorded.
          await h.clickAll(h.page.locator('[data-testid="pr-checks-summary"] > button'), { max: 1 });
          await h.clickAll(h.page.locator('[data-testid="pr-activity-section"] > button'), { max: 1 });
          await h.clickAll(h.page.getByRole('button', { name: /View log|Show log/ }), { max: 2 });
          await h.clickAll(h.page.getByRole('button', { name: /^(Merge|Merge when ready)$/ }), { max: 1, after: () => h.escape() });
        }
        await explore(h, { max: t === 'claude_review' || t === 'ai_fix' ? 20 : 10, scope: 'main' });
      },
    })),
  ),
  // The Changes tab's "Threads only" view (the old Threads tab): its list reads the bot-dedup
  // rollup, which the code view never asks for.
  ...[...DEEP_PRS, ...MORE_PRS].map((id) => ({
    name: `pr:${id}:changes-threads`,
    run: async (h) => {
      await h.go(`?view=pr-detail:${id}&prTab=changes`);
      await h.clickRole('button', /^Threads only/);
      await explore(h, { max: 10, scope: 'main' });
    },
  })),
  ...MORE_PRS.flatMap((id) =>
    ['overview', 'changes', 'claude_review'].map((t) => ({
      name: `pr:${id}:${t}`,
      run: (h) => h.go(`?view=pr-detail:${id}&prTab=${t}`),
    })),
  ),

  // ── People ──
  ...PEOPLE.map((id) => ({
    name: `user-activity:${id}`,
    run: async (h) => {
      await h.go(`?view=user-activity:${id}`);
      await explore(h, { max: 6, scope: 'main' });
    },
  })),

  // ── #105's run history: the Claude Opus and Codex GPT-6.1 Sol reviews of the same head ──
  {
    name: 'pr:105:review-history',
    run: async (h) => {
      await h.go('?view=pr-detail:105&prTab=claude_review');
      // Every run in the always-visible list, so showing any of them answers.
      await h.clickAll(h.page.locator('main [data-review-run]'), { max: 8 });
      await explore(h, { max: 30, scope: 'main' });
    },
  },

  // ── Settings (both halves; Settings → AI's provider choice and the Codex sign-in are simulated in
  //    the demo, apps/frontend/src/demo/provider.ts, so nothing there is recorded) ──
  {
    name: 'settings',
    run: async (h) => {
      await h.go('?view=activity');
      await h.openSettings();
      await h.scrollModal();
      await h.escape();
      // Related repos (Settings → Workspace), both workspaces.
      await h.fetchGet('/api/workspaces/1/related-repos');
      await h.fetchGet('/api/workspaces/2/related-repos');
    },
  },

  // ── People popovers, trunk trends, run history, polls the demo answers later ──
  {
    name: 'popovers',
    run: async (h) => {
      await h.go('?view=pr-detail:113&prTab=overview');
      for (const name of ['Priya Nair', 'Sam Carter', 'Wei Zhang']) {
        if (await h.click(h.page.getByRole('button', { name }).first())) await h.escape();
      }
      await h.go('?view=activity');
      await h.clickAll(h.page.locator('main button[aria-expanded="false"]'), { max: 6 });
      for (const repoId of [2, 3, 6, 7, 8, 1, 4, 5]) await h.fetchGet(`/api/branch-trends?repoId=${repoId}`);
      for (const userId of [1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16]) await h.fetchGet(`/api/users/${userId}/stats`);
      // Every stored review run and its chat — Claude's and Codex's (#105 holds one of each on the
      // same head), so picking any run in a PR's history answers.
      for (let id = 1; id <= 14; id++) {
        await h.fetchGet(`/api/claude-reviews/${id}`);
        await h.fetchGet(`/api/claude-reviews/${id}/chat`);
      }
      for (let id = 1; id <= 3; id++) await h.fetchGet(`/api/ci-reviews/${id}`);
      for (let id = 1; id <= 8; id++) await h.fetchGet(`/api/ticket-reviews/${id}`);
      await h.fetchGet('/api/sprint-graph/token?workspace=1');
      await h.fetchGet('/api/sprint-graph/token?workspace=2');
      await h.fetchGet('/api/workspace-metrics/detail?workspace=1');
      await h.fetchGet('/api/workspace-metrics/detail?workspace=2');
      await h.fetchGet('/api/repos/suggested');
      await h.fetchGet('/api/pro/bot-benchmark');
    },
  },

  // ── Search ──
  {
    name: 'search',
    run: async (h) => {
      for (const q of ['sync', 'webhook', 'terraform', 'PLAT-292']) await h.fetchGet(`/api/search?q=${enc(q)}&workspace=1`);
    },
  },

  // ── The second workspace, after everything in the default one ──
  { name: 'ws2:open-prs', run: (h) => h.go('?view=activity&workspace=2') },
  ...['attention', 'feed', 'bots', 'insights', 'docs'].map((r) => ({
    name: `ws2:${r}`,
    run: (h) => h.go(`?view=activity&workspace=2&activityRepo=${r}`),
  })),
  { name: 'ws2:sprint', run: (h) => h.go('?view=sprint&workspace=2') },
  { name: 'ws2:chronology', run: (h) => h.go('?view=activity&workspace=2&activityRepo=insights&insightsTab=bottlenecks') },
  ...WEB_PRS.flatMap((id) =>
    ['overview', 'changes', 'claude_review'].map((t) => ({
      name: `pr:${id}:${t}`,
      run: (h) => h.go(`?view=pr-detail:${id}&prTab=${t}&workspace=2`),
    })),
  ),
  {
    name: 'ws2:settings',
    run: async (h) => {
      await h.go('?view=activity&workspace=2');
      await h.openSettings();
      await h.scrollModal();
      await h.escape();
    },
  },
];
