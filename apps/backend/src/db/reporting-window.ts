import {
  REPORTING_DEFAULT_DAYS,
  type ReportingWindowInfo,
  type SprintComparisonMode,
} from '@pierre-review/shared';

// THE REPORTING WINDOW — the one window every Reports figure is tied to.
//
// The rule (user-set): every reporting figure is measured over the workspace's reporting window,
// and anything else is a LABELLED exception. The window is the workspace's comparison window:
// this sprint so far when the workspace has a sprint cadence and its mode is 'sprint', otherwise
// the trailing 7 or 14 days.
//
// ── ONE RESOLVER, AND IT IS THE PLUGIN'S ────────────────────────────────────────────────────
//
// The cadence and the mode live on the plugin's `pro_workspace_settings` row, and the function
// that turns them into a window is the plugin's `resolveComparisonWindow` (via
// `getComparisonWindow`). Core never re-derives it: the plugin REGISTERS that function here at boot
// (`ProContext.registerReportingWindow`, optional, so no apiVersion bump), and every core surface
// asks through `getReportingWindow`. With no plugin bound there is no cadence to read, and the
// answer is the trailing `REPORTING_DEFAULT_DAYS` — the same default `getWorkspaceMetrics` has
// always used when no window was handed in, so OSS mode is unchanged.
//
// ⚠ A RESOLVER FAILURE DEGRADES TO THE DEFAULT, never to an error: a Reports pane must still paint
// if the settings read throws, and the echoed `mode` then says 'rolling_14', so the label is true.

export interface ReportingWindow {
  fromMs: number;
  /** The window's own end. Later than now while a sprint is running. */
  toMs: number;
  mode: SprintComparisonMode;
}

export type ReportingWindowResolver = (args: {
  accountId: number;
  workspaceId: number;
  nowMs: number;
}) => Promise<ReportingWindow>;

let resolver: ReportingWindowResolver | null = null;

/** Called once by the plugin binding. A second call replaces the first. */
export function registerReportingWindowResolver(fn: ReportingWindowResolver | null): void {
  resolver = fn;
}

const DAY_MS = 86_400_000;

function defaultWindow(nowMs: number): ReportingWindow {
  return { fromMs: nowMs - REPORTING_DEFAULT_DAYS * DAY_MS, toMs: nowMs, mode: 'rolling_14' };
}

function isUsable(w: ReportingWindow | null | undefined, nowMs: number): w is ReportingWindow {
  return (
    w != null &&
    Number.isFinite(w.fromMs) &&
    Number.isFinite(w.toMs) &&
    w.toMs > w.fromMs &&
    // A window that has not started yet measures nothing; fall back rather than draw empty cards.
    // ⚠ ACCEPTED DIFFERENCE: with a sprint start set in the FUTURE, the free Reports cards read
    // the trailing 14 days (echoed mode 'rolling_14', so the label is true) while the Pro surfaces
    // that call the plugin's `currentSprintWindow` directly (workspace-insights header, sprint chat,
    // Slack) measure the not-yet-started sprint. It lasts only until the start date passes.
    w.fromMs <= nowMs
  );
}

/**
 * The workspace's reporting window. `workspaceId` is REQUIRED: the cadence is per workspace, so a
 * window taken without one would be some other team's sprint.
 */
export async function getReportingWindow(
  accountId: number,
  workspaceId: number,
  nowMs: number = Date.now(),
): Promise<ReportingWindow> {
  if (resolver != null) {
    try {
      const w = await resolver({ accountId, workspaceId, nowMs });
      if (isUsable(w, nowMs)) return { fromMs: w.fromMs, toMs: w.toMs, mode: w.mode };
    } catch {
      // Fall through to the default; see the header.
    }
  }
  return defaultWindow(nowMs);
}

/** The measured upper bound: a running sprint is measured up to now, never into the future. */
export function measuredTo(w: ReportingWindow, nowMs: number): number {
  return Math.min(w.toMs, nowMs);
}

/** The wire echo, so every card names the same window in the same words. */
export function reportingWindowInfo(w: ReportingWindow, nowMs: number): ReportingWindowInfo {
  const to = measuredTo(w, nowMs);
  return {
    mode: w.mode,
    from: new Date(w.fromMs).toISOString(),
    to: new Date(to).toISOString(),
    end: new Date(w.toMs).toISOString(),
    days: Math.round((w.toMs - w.fromMs) / DAY_MS),
    elapsedDays: Math.round(((to - w.fromMs) / DAY_MS) * 10) / 10,
  };
}
