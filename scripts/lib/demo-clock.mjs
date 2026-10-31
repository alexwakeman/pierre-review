// THE RECORDER'S SHIFTED CLOCK. An incremental record (`pnpm demo:record --only …` / `--changed`)
// merges fresh answers into a recording captured earlier. The seed is written relative to "now" and
// the demo rebases every body by `now − capturedAt`, so fresh answers must be captured AS OF the old
// recording's `capturedAt`: same sprint keys, same ages, same windows. This module moves the clock
// back by LIMN_CLOCK_OFFSET_MS milliseconds, and keeps it running.
//
//   node --import ./scripts/lib/demo-clock.mjs …   the seeder and the backend (NODE_OPTIONS)
//   browserClockScript(offsetMs)                    the same, as a Playwright init script
//
// ⚠ It moves JavaScript's Date only. A column whose DEFAULT is SQLite's `unixepoch()` still reads the
// real time — the seeder writes the timestamps the demo shows, so those defaults are bookkeeping.
const OFFSET = Number(globalThis.process?.env?.LIMN_CLOCK_OFFSET_MS ?? 0);

function install(offset) {
  if (!offset) return;
  const RealDate = Date;
  const shifted = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [RealDate.now() - offset] : args, newTarget);
    },
    apply() {
      return new RealDate(RealDate.now() - offset).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => RealDate.now() - offset;
      return Reflect.get(target, prop, receiver);
    },
  });
  globalThis.Date = shifted;
}

install(OFFSET);

/** The same shift, as source for `context.addInitScript` (runs before the page's own scripts). */
export function browserClockScript(offsetMs) {
  return `(${install.toString()})(${Number(offsetMs)});`;
}
