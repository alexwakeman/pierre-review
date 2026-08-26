import { useEffect, useMemo, useRef } from 'react';
import { useMyTurn } from './useTriage.js';
import { useRepos } from './useTimeline.js';
import { useWorkspaces } from './useWorkspaces.js';
import { dateTime } from '../lib/ui.js';

// Fire a browser notification when a NEW item enters your My Turn inbox (a review
// requested, a thread awaiting you, or your PR getting fresh activity). Watches the
// My Turn query — which refetches when a sync lands — and diffs the item id set
// across changes. The first data load only seeds the baseline (never fires), so you
// aren't notified about the backlog that was already there when you opened the tab.
// No-op unless enabled AND permission was granted. Notifications only fire while a
// tab is open (that's where the polling happens).
//
// ⚠ THIS WATCHER STAYS ACCOUNT-WIDE, deliberately, even though the Welcome-back banner and the
// Workspace dropdown are now per-workspace. A banner is read inside a scope, so it has to say
// which scope it is talking about; an OS notification is read outside the app entirely, where
// "only tell me about the workspace whose tab happened to be selected" would be a silence bug.
// What it owes instead is PROVENANCE — so the body/title now NAME the workspace the new items
// came from, resolved through `repos.workspaceId` (the client's only repo→workspace mapping).
export function useMyTurnNotifications(enabled: boolean): void {
  const { data } = useMyTurn();
  const { data: repos } = useRepos();
  const { data: workspaces } = useWorkspaces();
  const prevRef = useRef<Set<string> | null>(null);

  // repoFullName → Workspace name. My Turn rows carry `repoFullName`, not a repo id, so this is
  // the join; a repo the reference queries have not covered yet simply yields no name.
  const wsByRepo = useMemo(() => {
    const nameById = new Map((workspaces ?? []).map((w) => [w.id, w.name]));
    const out = new Map<string, string>();
    for (const r of repos ?? []) {
      const name = nameById.get(r.workspaceId);
      if (name != null) out.set(r.fullName, name);
    }
    return out;
  }, [repos, workspaces]);

  // ⚠ HELD IN A REF, AND KEPT OUT OF THE DIFF EFFECT'S DEPS ON PURPOSE. That effect ADVANCES the
  // notification baseline on every run, so re-running it because a REFERENCE query landed would
  // consume a real My-Turn diff and swallow the notification it should have fired. The lookup is
  // only ever read at the instant a change fires, and a run with a half-loaded map degrades to
  // the un-named copy rather than to silence. This sync effect is declared FIRST so it commits
  // ahead of the diff below in the same pass.
  const wsByRepoRef = useRef(wsByRepo);
  useEffect(() => {
    wsByRepoRef.current = wsByRepo;
  }, [wsByRepo]);

  useEffect(() => {
    if (!data) return;
    // id → THE EVENT CLOCK for that item, so the diff below can say when the newest thing
    // actually HAPPENED rather than when this poll noticed it. `MyTurnPr.since` is the server's
    // one resolution of that (review requested / last update / newest approval / opened) and a
    // thread's is its last reply; `openedAt` is only the documented fallback for a response
    // predating the field — never the clock we'd choose.
    const at = new Map<string, string>();
    // id → the row's repo, so the diff below can name the WORKSPACE an item arrived in. Built
    // alongside `at` rather than re-walked, so the two can never describe different id sets.
    const repoOf = new Map<string, string>();
    for (const r of data.awaitingReview) {
      at.set(`r:${r.prId}`, r.since ?? r.openedAt);
      repoOf.set(`r:${r.prId}`, r.repoFullName);
    }
    for (const p of data.yourPrs) {
      at.set(`p:${p.prId}`, p.since ?? p.openedAt);
      repoOf.set(`p:${p.prId}`, p.repoFullName);
    }
    for (const a of data.approvedPrs ?? []) {
      at.set(`a:${a.prId}`, a.since ?? a.openedAt);
      repoOf.set(`a:${a.prId}`, a.repoFullName);
    }
    for (const t of data.threadsAwaiting) {
      at.set(`t:${t.threadId}`, t.lastReplyAt);
      repoOf.set(`t:${t.threadId}`, t.repoFullName);
    }
    for (const w of data.watchedRepoPrs) {
      at.set(`w:${w.prId}`, w.since ?? w.openedAt);
      repoOf.set(`w:${w.prId}`, w.repoFullName);
    }

    const prev = prevRef.current;
    prevRef.current = new Set(at.keys()); // always advance the baseline, even while disabled

    if (prev == null) return; // first load → baseline only, don't fire
    if (!enabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const added = [...at.keys()].filter((id) => !prev.has(id));
    if (added.length === 0) return;

    const reviews = added.filter((id) => id.startsWith('r:')).length;
    const threads = added.filter((id) => id.startsWith('t:')).length;
    const yours = added.filter((id) => id.startsWith('p:')).length;
    const approved = added.filter((id) => id.startsWith('a:')).length;
    // `w:` and the wire field `watchedRepoPrs` keep their historical names (see the note on
    // `WatchedRepoPrItem` in shared/types.ts — the stored dismissal kind pins them); the SECTION
    // is "New PRs", and this copy has to say that, not resurrect a "watched" the user can't see.
    const newPrs = added.filter((id) => id.startsWith('w:')).length;
    const bits: string[] = [];
    if (reviews) bits.push(`${reviews} review${reviews === 1 ? '' : 's'} requested`);
    if (threads) bits.push(`${threads} thread${threads === 1 ? '' : 's'} awaiting you`);
    if (yours) bits.push(`${yours} of your PRs active`);
    if (approved) bits.push(`${approved} of your PRs approved`);
    if (newPrs) bits.push(`${newPrs} new PR${newPrs === 1 ? '' : 's'} in your repos`);

    // ONE notification covers N added items, so it carries ONE stamp: the NEWEST added item's
    // event time. (Splitting per item to stamp each would defeat the `tag` collapsing below,
    // which is what stops a backlog turning into a burst of banners.)
    // ⚠ ABSOLUTE, never relative: a notification is read once at delivery and then SITS in the
    // OS notification centre, where a "3 mins ago" quietly ages into a lie.
    let newestIso: string | null = null;
    let newestMs = -Infinity;
    for (const id of added) {
      const iso = at.get(id);
      if (iso == null) continue;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms) && ms > newestMs) {
        newestMs = ms;
        newestIso = iso;
      }
    }
    // Guard the RESOLUTION, not just the constructor: an unreadable timestamp must degrade to
    // now, never render "Invalid Date" into the body.
    const stamp = dateTime(newestIso ?? new Date().toISOString());

    // WHERE it came from. This watcher is account-wide (see the header), so a notification that
    // named no workspace left the reader to open the app and hunt for the scope the work is in —
    // and, since the banner became per-workspace, contradicted nothing but explained nothing
    // either. Distinct names only, alphabetical; a repo whose workspace hasn't resolved yet is
    // simply left out, degrading to the previous un-named copy rather than guessing.
    const wsLookup = wsByRepoRef.current;
    const wsNames: string[] = [];
    for (const id of added) {
      const repo = repoOf.get(id);
      const name = repo == null ? undefined : wsLookup.get(repo);
      if (name != null && !wsNames.includes(name)) wsNames.push(name);
    }
    wsNames.sort((a, b) => a.localeCompare(b));
    const onlyWs = wsNames.length === 1 ? wsNames[0] : undefined;
    // The TITLE carries the provenance when there is one workspace to carry — titles survive the
    // OS banner truncation that the body does not. Several workspaces → the title carries the
    // count and the body's tail carries the names, which is the half that may be cut.
    const where =
      onlyWs != null ? ` in ${onlyWs}` : wsNames.length > 1 ? ` across ${wsNames.length} Workspaces` : '';

    try {
      const n = new Notification(`Limn — ${added.length} new in My Turn${where}`, {
        // The stamp LEADS, on its own line: OS banners truncate the body (macOS to ~2 lines)
        // and the title already carries the count, so the moment is the half that has to
        // survive the cut.
        body: `${stamp}\n${bits.join(' · ')}${wsNames.length > 1 ? ` — ${wsNames.join(', ')}` : ''}`,
        tag: 'pierre-my-turn', // collapse so repeats replace rather than stack
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* construction can throw on some platforms — non-fatal */
    }
  }, [data, enabled]);
}
