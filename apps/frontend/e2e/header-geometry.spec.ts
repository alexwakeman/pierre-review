import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi, STORY_BUILD_PLAN_READY } from './mock-api.js';
import type { TicketPrsResponse } from '@pierre-review/shared';

// ONE PAGE HEADER GEOMETRY (docs/FRONTEND.md § One page header). Every full page and full-main
// overlay opens on the same title row: the page title (`[data-page-title]`, the page's one
// `text-display`) sits at the SAME distance from the top of the main content (`[data-shell-main]`)
// and the same distance from its left edge on every destination, at each width. A page that grows
// its own header (or a toast seat, or a stray top padding) shows up here as a different offset.
//
// The toast cluster's home (bottom right, out of the page flow) is pinned in pending-cards.spec.ts,
// where an Undo can be raised.

const ACME_1 = 'jira:https://acme.atlassian.net#ACME-1';

function ticketPrs(ident: string): TicketPrsResponse {
  return {
    workspaceId: fixtures.WORKSPACE.id,
    ident,
    found: true,
    ticket: {
      key: 'ACME-1',
      title: 'Export a report as CSV',
      url: 'https://acme.atlassian.net/browse/ACME-1',
      provider: 'jira',
      status: { name: 'To Do', category: 'new' },
    },
    open: [],
    merged: [],
    closed: [],
    outsideWorkspace: 0,
    truncated: false,
  };
}

async function setup(page: Page): Promise<void> {
  await installMockApi(page, { storyBuild: STORY_BUILD_PLAN_READY });
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route(
    (u) => u.pathname.endsWith('/api/me'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  // Two reads the shared fixtures do not answer (their untyped `{}` crashes the chart that reads
  // them, blanking the page): fail them, so the page draws its error state under its header.
  await page.route(
    (u) => u.pathname.includes('/api/bot-analytics') || u.pathname.endsWith('/api/pro/settings') || /\/api\/insights\/\d+\/analytics$/.test(u.pathname),
    (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not in the fixtures"}' }),
  );
  await page.route(
    (u) => u.pathname.endsWith('/api/ticket-prs'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ticketPrs(new URL(r.request().url()).searchParams.get('ident') ?? '')) }),
  );
}

const PR_ID = fixtures.PRS[0]!.id;
const PAGES: { name: string; url: string }[] = [
  { name: 'Pending', url: '/app/?view=activity&activityRepo=attention' },
  { name: 'Open PRs', url: '/app/?view=activity&activityRepo=open-prs' },
  { name: 'Feed', url: '/app/?view=activity&activityRepo=feed' },
  { name: 'Docs', url: '/app/?view=activity&activityRepo=docs' },
  { name: 'Reports', url: '/app/?view=activity&activityRepo=insights' },
  { name: 'Bots Monitoring', url: '/app/?view=activity&activityRepo=bots' },
  { name: 'Repository', url: `/app/?view=activity&activityRepo=${fixtures.REPO.id}` },
  { name: 'This Sprint', url: '/app/?view=sprint' },
  { name: 'Timeline', url: '/app/?view=timeline&preset=30d' },
  { name: 'PR detail', url: `/app/?view=pr-detail:${PR_ID}` },
  { name: 'Story', url: `/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}` },
  { name: 'Implement', url: `/app/?view=${encodeURIComponent(`story-build:${ACME_1}`)}` },
  { name: 'Person', url: '/app/?view=user-activity:2' },
  { name: 'Bot', url: '/app/?view=bot-detail:4' },
];

/** The page title's offset from the main content's top-left corner (the first visible title). */
async function titleOffset(page: Page, name = ''): Promise<{ top: number; left: number; text: string }> {
  const read = async (): Promise<{ top: number; left: number; text: string }> => {
    const handle = await page
      .waitForFunction(
        (sel) => {
          const main = document.querySelector('[data-shell-main]');
          if (main == null) return null;
          const el = [...main.querySelectorAll<HTMLElement>(sel)].find((e) => e.getBoundingClientRect().height > 0);
          if (el == null) return null;
          const m = main.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top - m.top), left: Math.round(r.left - m.left), text: (el.textContent ?? '').trim().slice(0, 40) };
        },
        TITLE,
        { timeout: 15_000 },
      )
      .catch(() => {
        throw new Error(`no page title on ${name}`);
      });
    return (await handle.jsonValue())!;
  };
  await read();
  // Let the header settle (fonts, a late chip), then read again.
  await page.waitForTimeout(400);
  return read();
}

const TITLE = '[data-page-title]';

for (const vp of [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
]) {
  test(`every page title sits at one offset — ${vp.w}×${vp.h}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await setup(page);
    const seen: { name: string; top: number; left: number; text: string }[] = [];
    for (const p of PAGES) {
      await page.goto(p.url, { waitUntil: 'domcontentloaded' });
      try {
        seen.push({ name: p.name, ...(await titleOffset(page, p.name)) });
      } catch (e) {
        expect.soft(String(e), `${p.name} has a page title`).toBe('');
      }
    }
    // eslint-disable-next-line no-console
    console.log(`${vp.w}×${vp.h}\n` + seen.map((s) => `  ${s.name.padEnd(16)} top ${s.top}  left ${s.left}  "${s.text}"`).join('\n'));
    const ref = seen[0]!;
    for (const s of seen) {
      expect.soft(Math.abs(s.top - ref.top), `${s.name} title top ${s.top} vs ${ref.name} ${ref.top}`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(s.left - ref.left), `${s.name} title left ${s.left} vs ${ref.name} ${ref.left}`).toBeLessThanOrEqual(1);
    }
  });
}
