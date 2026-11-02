import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';
import { bigDiff, type BigDiff } from './big-diff.js';
import type { PrFileContentResponse } from '@pierre-review/shared';

// THE CHANGES TAB ON A LARGE PR (100 files, ~18,000 diff rows, 54 threads — `big-diff.ts`). The
// tab mounts files and hunks as they near the screen, so these pin what must still work on content
// that is not mounted yet: a thread deep link into the LAST file, a rail click, the Threads only
// view (every thread, mounted or not), and the first paint's size. The two `measure` tests log the
// numbers docs/FRONTEND.md § Lazy mounting cites; they assert nothing and are SKIPPED unless
// `MEASURE=1` (`MEASURE=1 pnpm test:e2e --grep measure`; against a `vite build` + `vite preview` for
// production numbers).

const PR_ID = 101;

async function openBigPr(page: Page, query = '', edit?: (big: BigDiff) => void): Promise<BigDiff> {
  const big = bigDiff(PR_ID);
  edit?.(big);
  await installMockApi(page);
  // Registered AFTER the catch-all, so these win.
  await page.route(
    (url) => url.pathname === `/api/prs/${PR_ID}`,
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(big.detail) }),
  );
  await page.route(
    (url) => url.pathname === `/api/prs/${PR_ID}/files`,
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(big.files) }),
  );
  // The gap expander's one whole-file read.
  await page.route(
    (url) => url.pathname === `/api/prs/${PR_ID}/files/content`,
    (route) => {
      const u = new URL(route.request().url());
      const path = u.searchParams.get('path') ?? '';
      const body: PrFileContentResponse = {
        path,
        side: 'head',
        sha: 'deadbeef',
        lines: big.heads.get(path) ?? null,
        refused: big.heads.has(path) ? null : 'missing',
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    },
  );
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: { start: number; dur: number }[] };
    w.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* not supported */
    }
  });
  await page.goto(`/app/?view=pr-detail:${PR_ID}${query}`);
  return big;
}

/** Whether the element is wholly inside PrDetail's scroll pane (its nearest scrolling ancestor). */
async function inPane(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el == null) return false;
    let pane: HTMLElement | null = el.parentElement;
    while (pane != null) {
      const oy = getComputedStyle(pane).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      pane = pane.parentElement;
    }
    if (pane == null) return false;
    const r = el.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom;
  }, selector);
}

test.describe('Changes tab on a large PR', () => {
  test('measure: first paint of the Changes tab', async ({ page }) => {
    test.skip(!process.env.MEASURE, 'a measurement, not a check: MEASURE=1 to run');
    const big = await openBigPr(page);
    const tab = page.getByRole('tab', { name: /^Changes/ });
    await expect(tab).toBeVisible();
    const t0 = await page.evaluate(() => performance.now());
    await tab.click();
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    const t1 = await page.evaluate(
      () => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))),
    );
    // Let anything the first paint scheduled run.
    await page.waitForTimeout(1500);
    const stats = await page.evaluate((from) => {
      const w = window as unknown as { __longTasks: { start: number; dur: number }[] };
      const tasks = w.__longTasks.filter((t) => t.start >= from - 5);
      return {
        rows:
          document.querySelectorAll('[data-testid="changes-bar"] ~ div table tr').length -
          document.querySelectorAll('[data-diff-placeholder] tr').length,
        highlighted: document.querySelectorAll('[data-testid="changes-bar"] ~ div .code-hl').length,
        longTaskMs: Math.round(tasks.reduce((s, t) => s + t.dur, 0)),
        longestTaskMs: Math.round(Math.max(0, ...tasks.map((t) => t.dur))),
        domNodes: document.getElementsByTagName('*').length,
      };
    }, t0);
    console.log(
      `[changes-lazy] files=100 diffRows=${big.totalRows} threads=${big.threadCount} ` +
        `clickToPaintMs=${Math.round(t1 - t0)} longTaskMs=${stats.longTaskMs} longestTaskMs=${stats.longestTaskMs} ` +
        `mountedRows=${stats.rows} highlightedRows=${stats.highlighted} domNodes=${stats.domNodes}`,
    );
  });

  test('measure: a thread deep link into the last file', async ({ page }) => {
    test.skip(!process.env.MEASURE, 'a measurement, not a check: MEASURE=1 to run');
    const big = await openBigPr(page, `&prTab=changes&pr=${PR_ID}&thread=${bigDiff(PR_ID).targetThreadId}`);
    // From navigation start until the target thread's text sits inside the pane, and stays.
    const ms = await page.evaluate(async (needle) => {
      const inPaneNow = (): boolean => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n != null; n = walker.nextNode()) {
          if (!(n.textContent ?? '').includes(needle)) continue;
          const el = n.parentElement;
          if (el == null || el.closest('[data-testid="changes-threads-view"]') != null) continue;
          let pane: HTMLElement | null = el.parentElement;
          while (pane != null && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
          if (pane == null) return false;
          const r = el.getBoundingClientRect();
          const p = pane.getBoundingClientRect();
          return r.height > 0 && r.top >= p.top && r.bottom <= p.bottom;
        }
        return false;
      };
      const deadline = performance.now() + 40_000;
      let since: number | null = null;
      while (performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(r));
        if (inPaneNow()) {
          since ??= performance.now();
          if (performance.now() - since > 500) return Math.round(since);
        } else since = null;
      }
      return -1;
    }, 'The target thread: deep in the last file.');
    console.log(`[changes-lazy] threadDeepLinkSettledMs=${ms} (from navigation start) target=${big.targetPath}`);
  });

  test('a thread deep link lands on its pill in the last, unmounted file', async ({ page }) => {
    const big = await openBigPr(page, `&prTab=changes&pr=${PR_ID}&thread=${bigDiff(PR_ID).targetThreadId}`);
    const pill = `[data-thread-id="${big.targetThreadId}"] > button`;
    await expect(page.locator(pill)).toBeVisible();
    // Accurately: the pill sits inside the pane once layout settles, and stays there.
    await expect.poll(() => inPane(page, pill), { timeout: 5000 }).toBe(true);
    await page.waitForTimeout(800);
    expect(await inPane(page, pill)).toBe(true);
    // Opened, and ringed (the reveal's flash).
    await expect(page.locator(`[data-thread-id="${big.targetThreadId}"]`)).toHaveClass(/ring-2/);
    await expect(page.locator(`[data-thread-id="${big.targetThreadId}"] > button`)).toHaveAttribute('aria-expanded', 'true');
  });

  // GUARD for the "jumping" bug (lazyMount.ts `useHoldAboveReader`): code mounting ABOVE the reader
  // must leave what they see exactly still, and only the pane may scroll, never the page. ⚠ This
  // fixture does NOT reproduce the original fault (Chrome's own anchoring coped with its rows; it
  // passed before the fix too). The fault was MEASURED on a real PR: the thread dropped 365px for a
  // frame and was snapped back, and a 300px wheel step moved the code 364px. This pins the behaviour
  // so a later change cannot break it on simple code either.
  test('a thread deep link holds still while the code around it mounts, and scrolling up is exact', async ({ page }) => {
    // Long open threads just above the target, in code not yet mounted: each mounts far taller than
    // its estimate.
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: the reviewer explains the change at length.`).join('\n\n');
    const big = await openBigPr(page, `&prTab=changes&pr=${PR_ID}&thread=${bigDiff(PR_ID).targetThreadId}`, (b) => {
      const target = b.detail.threads.find((t) => t.id === b.targetThreadId)!;
      for (const [k, line] of [315, 325, 335, 345, 355].entries()) {
        const id = 99_100 + k;
        b.detail.threads.push({ ...target, id, line, comments: [{ ...target.comments[0]!, id: id * 10, body: long }] });
      }
    });
    const sel = `[data-thread-id="${big.targetThreadId}"]`;
    // Every frame from the moment the pill exists: once the landing scroll has stopped (three equal
    // frames), the pill never moves again — no frame where it drops and is snapped back.
    const tops = await page.evaluate(
      (s) =>
        new Promise<number[]>((done) => {
          const out: number[] = [];
          let t0 = 0;
          const tick = (): void => {
            const el = document.querySelector(s);
            if (el != null) {
              if (t0 === 0) t0 = performance.now();
              out.push(Math.round(el.getBoundingClientRect().top));
            }
            if (t0 === 0 || performance.now() - t0 < 2500) requestAnimationFrame(tick);
            else done(out);
          };
          requestAnimationFrame(tick);
        }),
      sel,
    );
    const still = tops.findIndex((t, i) => i >= 2 && t === tops[i - 1] && t === tops[i - 2]);
    expect(still).toBeGreaterThanOrEqual(0);
    const after = tops.slice(still);
    expect(Math.max(...after) - Math.min(...after), `pill tops after landing: ${[...new Set(after)].join(',')}`).toBeLessThanOrEqual(1);
    await expect.poll(() => inPane(page, `${sel} > button`)).toBe(true);
    // Scrolling up mounts the code above; each wheel step moves the content by exactly that step.
    const box = (await page.locator(sel).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y);
    const at = (): Promise<number> => page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().top, sel);
    for (let i = 0; i < 12; i++) {
      const before = await at();
      await page.mouse.wheel(0, -300);
      await expect.poll(async () => Math.round((await at()) - before)).toBeGreaterThanOrEqual(299);
      expect(Math.round((await at()) - before)).toBeLessThanOrEqual(301);
    }
    // Only the pane scrolled: the page itself never did.
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  });

  test('the first paint mounts only what is near the screen', async ({ page }) => {
    const big = await openBigPr(page, '&prTab=changes');
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    await page.waitForTimeout(500);
    const rows = await page.locator('[data-diff-row]').count();
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(big.totalRows / 4);
    // What is mounted is highlighted (per chunk), and nothing else was lexed.
    expect(await page.locator('[data-diff-row] .code-hl').count()).toBe(rows);
    // Every file header is there (the rail, n/p and find-by-file still see the whole list).
    await expect(page.locator('[data-file-block]')).toHaveCount(100);
  });

  test('a rail click on the last file scrolls its header into view', async ({ page }) => {
    const big = await openBigPr(page, '&prTab=changes');
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    const name = big.targetPath.split('/').at(-1)!;
    await page
      .getByRole('navigation', { name: 'Changed files' })
      .getByRole('button', { name: new RegExp(name.replace('.', '\\.')) })
      .first()
      .click();
    const header = `[data-file-block="${big.targetPath}"] > div`;
    await expect.poll(() => inPane(page, header), { timeout: 5000 }).toBe(true);
    // Its rows mount once it is on screen.
    await expect(page.locator(`[data-file-block="${big.targetPath}"] [data-diff-row]`).first()).toBeVisible();
  });

  test('Threads only lists every thread, mounted or not', async ({ page }) => {
    const big = await openBigPr(page, '&prTab=changes');
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    await page.getByTestId('changes-threads-only').click();
    const view = page.getByTestId('changes-threads-view');
    await expect(view).toBeVisible();
    await expect(view.getByText('The target thread: deep in the last file.')).toHaveCount(1);
    await expect(page.getByTestId('changes-threads-only')).toContainText(String(big.threadCount));
  });

  test('"Show in context" from Threads only lands on the pill in an unmounted file', async ({ page }) => {
    const big = await openBigPr(page, '&prTab=changes');
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    await page.getByTestId('changes-threads-only').click();
    const card = page
      .getByTestId('changes-threads-view')
      .locator('div', { hasText: 'The target thread: deep in the last file.' })
      .filter({ has: page.getByRole('button', { name: /^Show in context/ }) })
      .last();
    await card.getByRole('button', { name: /^Show in context/ }).click();
    await expect(page.getByTestId('changes-threads-view')).toHaveCount(0);
    const pill = `[data-thread-id="${big.targetThreadId}"] > button`;
    await expect.poll(() => inPane(page, pill), { timeout: 5000 }).toBe(true);
    await page.waitForTimeout(800);
    expect(await inPane(page, pill)).toBe(true);
    // The rows around it are highlighted too: its chunk mounted, and lexed, on demand.
    await expect(
      page.locator(`[data-file-block="${big.targetPath}"] [data-diff-row] .code-hl`).first(),
    ).toBeVisible();
  });

  test('a lock file mid-PR still starts collapsed; opening it mounts its rows', async ({ page }) => {
    await openBigPr(page, '&prTab=changes');
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    await page
      .getByRole('navigation', { name: 'Changed files' })
      .getByRole('button', { name: /pnpm-lock\.yaml/ })
      .first()
      .click();
    const block = page.locator('[data-file-block="pnpm-lock.yaml"]');
    // A rail click is an explicit reveal, and a reveal always opens its file — as before.
    await expect.poll(() => inPane(page, '[data-file-block="pnpm-lock.yaml"] > div'), { timeout: 5000 }).toBe(true);
    await expect(block.locator('[data-diff-row]').first()).toBeVisible();
    // Collapse it by hand, and it is shut (its rows gone), as before.
    await block.getByRole('button', { name: /pnpm-lock\.yaml/ }).click();
    await expect(block.locator('[data-diff-row]')).toHaveCount(0);
  });

  test('a lock file is collapsed on first paint, even when scrolled into view', async ({ page }) => {
    await openBigPr(page, '&prTab=changes');
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    await page.locator('[data-file-block="pnpm-lock.yaml"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-file-block="pnpm-lock.yaml"] [data-diff-row]')).toHaveCount(0);
    await expect(page.locator('[data-file-block="pnpm-lock.yaml"] button[title="Expand this file"]')).toBeVisible();
  });

  test('the gap expander still reveals hidden lines', async ({ page }) => {
    const big = await openBigPr(page, '&prTab=changes');
    await page.locator('button[title="Collapse this file"]').first().waitFor();
    const first = page.locator(`[data-file-block="${[...big.heads.keys()][0]}"]`);
    await first.getByRole('button', { name: 'Expand 20 lines down' }).first().click();
    await expect(first.getByText('// filler line 91', { exact: true })).toBeVisible();
    await expect(first.getByText('// filler line 110', { exact: true })).toBeVisible();
    await expect(first.getByText('// filler line 111', { exact: true })).toHaveCount(0);
  });
});
