// The fixed "Open PRs" tab chip's figure (PinnedTabsBar). Pure so it is pinned by
// test/openPrsTab.test.ts; it used to be My turn's "Open PRs · N" button, retired when Open PRs
// became a permanent tab between Activity and Timeline.

/** The workspace's NON-DRAFT open PRs — the same figure the Reports → Flow metrics tile and the
 *  tab's own header lead with. ⚠ UNKNOWN IS NEVER ZERO: no answer yet (including the idle query
 *  while `workspaceId` is null), or a placeholder carried over from the PREVIOUS workspace
 *  (`placeholderData: prev`), is `null`. */
export function openPrsTabCount(
  data: { prs?: readonly { isDraft: boolean }[] } | undefined,
  isPlaceholderData: boolean,
): number | null {
  if (data == null || isPlaceholderData) return null;
  // `?? []` — a response missing the array reads as "nothing", never a throw (no error boundary).
  return (data.prs ?? []).reduce((n, p) => n + (p.isDraft ? 0 : 1), 0);
}

/** "Open PRs · 12", or just "Open PRs" while the count is unknown. */
export function openPrsTabLabel(count: number | null): string {
  return count == null ? "Open PRs" : `Open PRs · ${count}`;
}
