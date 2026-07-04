import type { CheckLogsResponse } from '@pierre-review/shared';
import { ghRestGetText } from './client.js';

// Fetch a GitHub Actions job's log, live (never stored). Extracted from the
// /api/prs/:id/checks/:jobId/logs route so both that route and the Pro CI-analysis
// seam share one implementation. Takes an explicit account token as its first arg (so
// it works in cloud too). Degrades to { available:false, reason } on any GitHub error
// (expired logs / re-run / no actions:read / network) instead of throwing.
//
// `tail`: a POSITIVE value returns the last N lines (the UI "view logs" behaviour,
// capped at 1000). A value <= 0 returns the FULL log — used by the CI-analysis
// summariser, which must see the WHOLE log (the failure is often buried above a UI
// tail of upload/cleanup steps) and then extract the relevant part itself.
export async function fetchActionsJobLog(
  token: string,
  owner: string,
  name: string,
  jobId: number,
  tail = 200,
): Promise<CheckLogsResponse> {
  const unavailable = (reason: string): CheckLogsResponse => ({
    available: false,
    reason,
    text: '',
    totalLines: 0,
    returnedLines: 0,
  });

  try {
    const res = await ghRestGetText(
      token,
      `/repos/${owner}/${name}/actions/jobs/${jobId}/logs`,
    );
    if (!res.ok) {
      const reason =
        res.status === 404 || res.status === 410
          ? 'Logs are no longer available (expired, or the job was re-run).'
          : res.status === 403
            ? 'No permission to read GitHub Actions logs for this repo.'
            : `Couldn't fetch logs (GitHub returned ${res.status}).`;
      return unavailable(reason);
    }
    // A job log can be many MB — normalise line endings, drop a trailing blank. Guard
    // the empty body so it reports 0 lines (not [''] → a misleading "1 of 1").
    const trimmed = res.text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const lines = trimmed === '' ? [] : trimmed.split('\n');
    const wantsFull = tail <= 0;
    const tailLines = wantsFull
      ? lines.length
      : Math.min(Math.max(tail, 1), 1000);
    const selected = wantsFull ? lines : lines.slice(-tailLines);
    return {
      available: true,
      text: selected.join('\n'),
      totalLines: lines.length,
      returnedLines: selected.length,
    };
  } catch {
    return unavailable("Couldn't reach GitHub to fetch the logs.");
  }
}
