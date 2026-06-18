// Lightweight, opt-in performance probe. Enable it by adding `?perf` to any app
// URL (e.g. http://localhost:5173/app/?perf, or .../app/?pr=123&perf). It is
// loaded via a dynamic import in main.tsx ONLY when the flag is present, so it
// adds nothing to a normal session.
//
// It surfaces the three signals a JS-function profiler (CPU tab) cannot show for a
// PAINT / COMPOSITOR-bound stall — the kind that pegs a renderer with the script
// flamechart looking idle:
//
//   • FPS — a once-per-second sample driven by requestAnimationFrame. A sustained
//     sub-30fps with NO long tasks is the fingerprint of a compositor/paint loop
//     (animated box-shadow, oversized repaints), NOT hot JavaScript.
//   • Long tasks + layout shifts — PerformanceObserver entries. `longtask`
//     (>50ms main-thread blocks) points at JS/layout; their ABSENCE while FPS is
//     low points at paint/raster.
//   • A DOM census of the timeline — total `.vis-item`, animated `.pr-myturn`
//     bars, and total node count — so you can correlate cost with board size and
//     confirm the animated-glow count.
//
// All output is prefixed `[perf]` in the console.

let started = false;

export function startPerfProbe(): void {
  if (started) return;
  started = true;

  const log = (...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log('%c[perf]', 'color:#38bdf8;font-weight:700', ...args);

  log('probe enabled — watch fps, longtasks, and the .pr-myturn census below');

  // ---- FPS: count rAF ticks, report every ~1s, track the worst frame gap ----
  let frames = 0;
  let prevFrame = performance.now();
  let lastReport = prevFrame;
  let worstFrameMs = 0;
  const tick = (now: number) => {
    frames += 1;
    const gap = now - prevFrame;
    if (gap > worstFrameMs) worstFrameMs = gap;
    prevFrame = now;
    const elapsed = now - lastReport;
    if (elapsed >= 1000) {
      const fps = Math.round((frames * 1000) / elapsed);
      const flag = fps < 30 ? '  ⚠ SLOW (sub-30fps)' : '';
      log(`fps ${fps}  worst-frame ${Math.round(worstFrameMs)}ms${flag}`);
      frames = 0;
      worstFrameMs = 0;
      lastReport = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- Long tasks + cumulative layout shift (best-effort; not in every browser) ----
  let longTaskCount = 0;
  let longTaskMs = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTaskCount += 1;
        longTaskMs += e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    log('longtask observer unsupported in this browser');
  }

  let cls = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // layout-shift entries carry a numeric `value` not on the base type
        const v = (e as PerformanceEntry & { value?: number }).value;
        if (typeof v === 'number') cls += v;
      }
    }).observe({ entryTypes: ['layout-shift'] });
  } catch {
    /* layout-shift not supported — skip silently */
  }

  // ---- DOM census + accumulated observer totals, every 5s ----
  window.setInterval(() => {
    const visItems = document.querySelectorAll('.vis-item').length;
    const myturn = document.querySelectorAll('.vis-item.pr-myturn').length;
    const nodes = document.getElementsByTagName('*').length;
    log(
      `census: nodes ${nodes}  .vis-item ${visItems}  .pr-myturn ${myturn}` +
        `  | last 5s: longtasks ${longTaskCount} (${Math.round(longTaskMs)}ms)  cls ${cls.toFixed(3)}`,
    );
    if (myturn >= 12) {
      log(
        `  ⚠ ${myturn} "my turn" bars on screen — each used to animate box-shadow ` +
          `(continuous repaint); now opacity-pulsed on a composited layer`,
      );
    }
    longTaskCount = 0;
    longTaskMs = 0;
    cls = 0;
  }, 5000);
}
