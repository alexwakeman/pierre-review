import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RELEASE_OLDER_TAGS_MAX, type ReleaseCheckPr, type ReleaseCheckResult, type ReleaseRepoCheck } from '@pierre-review/shared';
import { useRefreshReleases, useReleases, useShowMoreOlderTags } from '../../hooks/useReleases.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  ExternalLinkIcon,
  GearIcon,
  MergeIcon,
  PartialCircleIcon,
  QuestionIcon,
  RefreshIcon,
  RocketIcon,
  SkipIcon,
  StarIcon,
} from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { FOCUS_RING } from '../ui/cx.js';
import { SprintProgressBar } from '../Activity/SprintProgressBar.js';
import { ReleaseDetailModal, ReleaseDialog } from './ReleaseDialog.js';
import {
  latestReleaseLine,
  openInTrackerWords,
  readAgoWords,
  refreshingLine,
  releaseDayWords,
  repoLatestNote,
  repoProgress,
  showCreateRelease,
  type ReleasePrLine,
} from './releasesModel.js';
import {
  TICKET_MARK_WORDS,
  TICKET_WINDOW_START,
  TICKET_WINDOW_STEP,
  noTicketGroupWords,
  noTicketPrLineOf,
  noTicketShownPrs,
  listedItems,
  releaseHolders,
  reposWithoutCandidate,
  repoStripText,
  repoTagWords,
  showTicketsWords,
  ticketCardLine,
  ticketCardPrLines,
  ticketCardStatus,
  ticketList,
  ticketWindow,
  type NoTicketGroup,
  type ReleaseHolder,
  type TicketCardModel,
  type TicketMark,
} from './releaseTicketsModel.js';

// THIS SPRINT → RELEASES (docs/RELEASES.md § Releases tab) — the 4th This Sprint tab (key 4).
//
//   • Header: "Latest release: none" / "Latest release: 12 Nov", the ⓘ with the rules, "View notes" for
//     the newest release made here, Refresh.
//   • A line per releasable repo with NO candidate (no version tags, nothing new, none can be released, or
//     "Checking…" with a bar and ONE line). The candidates are on the candidate ticket.
//   • THE TICKET LIST (releaseTicketsModel.ts), in its own bordered box: ONE list of ticket cards in tag order,
//     newest first, opened on the candidate ticket (★) with one either side, "Show 3 later / earlier tickets".
//     The ★ card names each repository's candidate and its commit (the HEAD that would be released) and has
//     ONE "Release…" for all of them (SHOWN only with a candidate the reader can push — hidden, never
//     disabled). PRs with no ticket are narrow rows between the cards; bot PRs are left out of their lists
//     unless "Show bot PRs" is ticked (the counts always name them). A card: mark, key, title, status, the
//     latest tag per repository and ONE line; its PRs and tags open behind the arrow.
//   • Below it, apart in a second bordered box: "Not in a tag yet" (tickets with only open work) and "Holding
//     the release" (always shown).
//
// ⚠ ONE FETCH ON MOUNT: GET /api/releases (DB + memory only); it POLLS that same GET every ~3 s only
// while a repo is checking or its older tags are read (hooks/useReleases.ts). "Show earlier tickets" past
// what the server sent is a press (POST /api/releases/older-tags); a card's detail is in the check already
// (no fetch on open). Refresh (a press) reads the tickets not Complete, not read yet or not found again
// from the tracker (POST /api/releases/refresh).
// ⚠ Nothing renders while `workspaceId` is null. Not configured, or no repo ticked "Released from this
// workspace": ONE setup line linking to Settings → Releases.
// ⚠ "Story" opens the story through `useOpenStory()`; a pull request opens its PR tab (or GitHub).

export function ReleasesView(): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const q = useReleases(workspaceId);
  const refresh = useRefreshReleases(workspaceId);
  const openSettings = useSettingsModal((s) => s.openSettings);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewRelease, setViewRelease] = useState<number | null>(null);
  const onRefresh = useCallback(() => refresh.mutate(), [refresh]);

  if (workspaceId == null) return null;
  if (q.isLoading) return <p className="py-6 text-body text-ui-mute">Loading releases…</p>;
  if (q.isError || q.data == null) return <p className="py-6 text-body text-ui-danger">Couldn’t load releases.</p>;
  const data = q.data;

  if (!data.configured || !data.hasReleasableRepos || data.check == null) {
    return (
      <div data-testid="releases-view" className="flex flex-col items-center gap-3 rounded-ui bg-ui-surface px-6 py-10 text-center text-body text-ui-mute">
        <span>
          {!data.configured
            ? 'Set the release and hotfix suffixes to see which version tags are safe to release.'
            : 'Tick the repositories released from this workspace to see which version tags are safe to release.'}
        </span>
        <button
          type="button"
          onClick={() => openSettings('releases')}
          className={`inline-flex h-8 items-center gap-1.5 rounded-ui bg-ui-raise px-3 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-11 ${FOCUS_RING}`}
        >
          <GearIcon size={13} />
          Set up in Settings
        </button>
      </div>
    );
  }
  const check = data.check;
  const busy = refresh.isPending;
  const otherRepos = reposWithoutCandidate(check);

  return (
    <div data-testid="releases-view" className="space-y-5 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-title text-ui-ink">{latestReleaseLine(data)}</h2>
        <InfoButton title="How releases are checked">
          <p>Only repositories ticked “Released from this workspace” in Settings are checked.</p>
          <p>
            Releasing a tag ships everything below it. So the candidate is the newest version tag on main where that tag
            and every tag below it have all their tickets Complete, with no pull request still open for any of them in a
            released repository. Before the first release every tag on main counts; after a release, only the tags since
            it. The repositories are picked together: no Complete ticket is released with only part of its work.
          </p>
          <p>
            The list shows tickets, newest tag first. A ticket sits where its latest tag sits, in any repository. ★ is the
            newest ticket in the release candidates: it names each repository’s candidate and its commit, and Release…
            releases them together. ✓ is in the candidates; ✗ is not Complete or has a pull request still open; the amber
            mark is Complete but held back by another ticket; ? is a ticket the tracker could not give — it does not stop
            a release, so check it by hand. Narrow rows are pull requests with no ticket.
          </p>
          <p>Release… tags each candidate with the release suffix, publishes the notes and comments on each ticket.</p>
        </InfoButton>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {data.latestRelease != null && (
            <Button size="sm" variant="ghost" onClick={() => setViewRelease(data.latestRelease!.id)}>
              View notes
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<RefreshIcon size={13} />} busy={busy} busyLabel="Refreshing…" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </div>

      {busy && (
        // Refresh reads tickets from the tracker again — may take more than a few seconds.
        <div className="flex items-center gap-2" data-testid="release-refresh-progress">
          <SprintProgressBar progress={{ kind: 'busy', label: refreshingLine(check) }} className="h-1.5 w-40 shrink-0 rounded-full" testId="release-refresh-progress-bar" />
          <span className="min-w-0 text-meta text-ui-mute">{refreshingLine(check)}</span>
        </div>
      )}
      {refresh.isError && <p className="text-meta text-ui-danger">Couldn’t refresh. Try again.</p>}
      {refresh.data != null && refresh.data.unread.length > 0 && (
        <p className="text-meta text-ui-mute">The tracker did not answer for {refresh.data.unread.join(', ')}.</p>
      )}

      {otherRepos.length > 0 && (
        <section aria-label="Repositories with no candidate">
          <ul className="divide-y divide-ui-line overflow-hidden rounded-ui bg-ui-surface">
            {otherRepos.map((r) => (
              <RepoStrip key={r.repoId} repo={r} />
            ))}
          </ul>
        </section>
      )}

      <TicketListView check={check} workspaceId={workspaceId} onRelease={() => setDialogOpen(true)} />

      {dialogOpen && (
        <ReleaseDialog
          workspaceId={workspaceId}
          check={check}
          onClose={() => setDialogOpen(false)}
          onViewRelease={(id) => {
            setDialogOpen(false);
            setViewRelease(id);
          }}
        />
      )}
      {viewRelease != null && <ReleaseDetailModal id={viewRelease} onClose={() => setViewRelease(null)} />}
    </div>
  );
}

/** A repository with no candidate: why ("No version tags on main yet", "Nothing new since …", "No tag can be
 *  released"), or "Checking…" with its bar and ONE line. The candidates live on the candidate ticket. */
function RepoStrip({ repo }: { repo: ReleaseRepoCheck }): JSX.Element {
  const progress = repoProgress(repo);
  const tone = repo.status === 'none' ? 'text-ui-warn' : 'text-ui-mute';
  return (
    <li data-testid="release-repo-row" data-repo={repo.name} data-status={repo.status} className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-body">
        <span className="font-medium text-ui-ink">{repo.name}</span>
        <span className={`min-w-0 ${tone}`}>{repoStripText(repo)}</span>
      </div>
      {progress != null && (
        <div className="mt-1 flex items-center gap-2" data-testid="release-progress">
          <SprintProgressBar
            progress={{ kind: 'share', label: progress.line ?? 'Checking', value: progress.share }}
            className="h-1.5 w-40 shrink-0 rounded-full"
            testId="release-progress-bar"
          />
          {progress.line != null && <span className="min-w-0 text-meta text-ui-mute">{progress.line}</span>}
        </div>
      )}
    </li>
  );
}

/** The candidates on the candidate ticket: per repository "0.316.0 → 0.316.0-rc · e18c3b2 · 23 Oct", and ONE
 *  Release… for all of them (HIDDEN unless one can be released by the reader). */
function CandidateBlock({ check, onRelease }: { check: ReleaseCheckResult; onRelease: () => void }): JSX.Element {
  const repos = check.repos.filter((r) => r.candidate != null);
  return (
    <div className="flex flex-wrap items-end gap-2 pt-1" data-testid="release-candidates">
      <ul className="min-w-0 space-y-0.5 text-meta">
        {repos.map((r) => {
          const c = r.candidate!;
          const href = safeExternalUrl(`https://github.com/${r.fullName}/commit/${c.sha}`);
          const day = releaseDayWords(c.committedAt);
          const latest = repoLatestNote(r);
          return (
            <li key={r.repoId} className="flex flex-wrap items-center gap-x-1.5 text-ui-mute" data-testid="release-candidate" data-repo={r.name}>
              <span className="font-medium text-ui-ink">{r.name}</span>
              <span className="text-ui-ink">{repoStripText(r)}</span>
              <span>·</span>
              {href != null ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  data-testid="release-candidate-sha"
                  className={`rounded-ui font-mono text-ui-ink hover:underline ${FOCUS_RING}`}
                  title="The commit this release would ship (HEAD of the candidate tag)"
                >
                  {c.sha.slice(0, 7)}
                </a>
              ) : (
                <span className="font-mono">{c.sha.slice(0, 7)}</span>
              )}
              {day != null && <span>· {day}</span>}
              {latest != null && <span>· {latest}</span>}
              {!r.writable && <span className="text-ui-faint">· No push access</span>}
              {c.releaseTagExists && <span className="text-ui-warn">· {c.releaseTagName} already exists</span>}
            </li>
          );
        })}
      </ul>
      {showCreateRelease(check) && (
        <span className="ml-auto" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Button size="sm" variant="primary" icon={<RocketIcon size={13} />} onClick={onRelease}>
            Release…
          </Button>
        </span>
      )}
    </div>
  );
}

/** The candidate tickets in their own bordered box; below it, apart, "Not in a tag yet" and "Holding the release". */
function TicketListView({ check, workspaceId, onRelease }: { check: ReleaseCheckResult; workspaceId: number; onRelease: () => void }): JSX.Element {
  const list = useMemo(() => ticketList(check), [check]);
  const holders = useMemo(() => releaseHolders(check), [check]);
  const repoNames = useMemo(() => new Map(check.repos.map((r) => [r.repoId, r.name])), [check]);
  const [up, setUp] = useState(TICKET_WINDOW_START);
  const [down, setDown] = useState(TICKET_WINDOW_START);
  const [showBots, setShowBots] = useState(false);
  const [showNoTicket, setShowNoTicket] = useState(false);
  const [focus, setFocus] = useState<{ ident: string; seq: number } | null>(null);
  const more = useShowMoreOlderTags(workspaceId);
  const w = ticketWindow(list, up, down);
  const ctx = { holders, repoNames, trackerName: check.trackerName };
  const onFocus = (h: ReleaseHolder): void => setFocus((f) => ({ ident: h.ident, seq: (f?.seq ?? 0) + 1 }));
  const byIdent = new Map(list.tickets.map((c) => [c.ticket.ident, c]));
  const holderCards = holders.map((h) => byIdent.get(h.ident) ?? list.notTagged.find((c) => c.ticket.ident === h.ident)).filter((c): c is TicketCardModel => c != null);
  // Past the tickets sent: older tags the server has not read for the list yet.
  const olderToAsk = check.repos.filter((r) => r.candidate != null && r.older.moreAvailable);
  const loadingOlder = check.repos.some((r) => r.older.loading);
  const askOlder = (): void => {
    for (const r of olderToAsk) more.mutate({ repoId: r.repoId, wanted: Math.min(RELEASE_OLDER_TAGS_MAX, r.older.wanted + 10) });
  };
  const card = (c: TicketCardModel, where: string): JSX.Element => (
    <TicketCard
      key={`${where}-${c.ticket.ident}`}
      card={c}
      check={check}
      ctx={ctx}
      onFocus={onFocus}
      focus={where === 'hold' && focus?.ident === c.ticket.ident ? focus.seq : null}
      extra={where === 'list' && c.isAnchor ? <CandidateBlock check={check} onRelease={onRelease} /> : null}
      railed={where === 'list'}
    />
  );
  const hasNoTicket = w.items.some((i) => i.kind === 'no_ticket');
  const items = listedItems(w.items, showNoTicket);

  return (
    <div data-testid="release-tickets">
      <section aria-label="Tickets" className="space-y-1.5 rounded-ui border border-ui-line p-3">
        {hasNoTicket && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <label className="flex w-fit cursor-pointer items-center gap-1.5 text-meta text-ui-mute" data-testid="release-show-no-ticket">
              <input type="checkbox" checked={showNoTicket} onChange={(e) => setShowNoTicket(e.target.checked)} className={FOCUS_RING} />
              Show PRs with no ticket
            </label>
            {showNoTicket && (
              <label className="flex w-fit cursor-pointer items-center gap-1.5 text-meta text-ui-mute" data-testid="release-show-bots">
                <input type="checkbox" checked={showBots} onChange={(e) => setShowBots(e.target.checked)} className={FOCUS_RING} />
                Show bot PRs
              </label>
            )}
          </div>
        )}
        {w.moreUp > 0 && (
          <MoreButton onClick={() => setUp((n) => n + TICKET_WINDOW_STEP)} testId="release-show-later">
            <ChevronIcon dir="up" size={11} className="shrink-0" />
            {showTicketsWords('later', w.moreUp)}
          </MoreButton>
        )}
        {list.tickets.length === 0 && w.items.length === 0 && <p className="text-meta text-ui-mute">No tickets in the tags read.</p>}
        <ol className="relative space-y-1.5" data-testid="release-ticket-list">
          {/* THE RAIL (the PR Activity tab's design): one line behind every row's marker. */}
          {items.length > 1 && <span aria-hidden className="absolute bottom-4 top-4 left-[11.5px] w-px bg-ui-line" />}
          {items.map((i) => (i.kind === 'ticket' ? card(i, 'list') : <NoTicketRow key={i.key} group={i} check={check} showBots={showBots} />))}
        </ol>
        {w.moreDown > 0 ? (
          <MoreButton onClick={() => setDown((n) => n + TICKET_WINDOW_STEP)} testId="release-show-earlier">
            <ChevronIcon dir="down" size={11} className="shrink-0" />
            {showTicketsWords('earlier', w.moreDown)}
          </MoreButton>
        ) : (
          olderToAsk.length > 0 &&
          !loadingOlder && (
            <MoreButton onClick={askOlder} busy={more.isPending} testId="release-show-earlier">
              <ChevronIcon dir="down" size={11} className="shrink-0" />
              Read earlier tags
            </MoreButton>
          )
        )}
        {loadingOlder && (
          <div className="flex items-center gap-2" data-testid="release-older-progress">
            <SprintProgressBar progress={{ kind: 'busy', label: 'Reading earlier tags' }} className="h-1.5 w-40 shrink-0 rounded-full" testId="release-older-progress-bar" />
            <span className="min-w-0 text-meta text-ui-mute">Reading earlier tags</span>
          </div>
        )}
        {more.isError && <p className="text-meta text-ui-danger">Couldn’t ask for earlier tags. Try again.</p>}
      </section>

      {(list.notTagged.length > 0 || holderCards.length > 0) && (
        <section aria-label="Not in a tag yet and holding the release" className="mt-8 space-y-4 rounded-ui border border-ui-line p-3" data-testid="release-elsewhere">
          {list.notTagged.length > 0 && (
            <div className="space-y-1.5" data-testid="release-not-tagged">
              <h3 className="text-meta font-medium text-ui-mute">Not in a tag yet</h3>
              <ul className="space-y-1.5">{list.notTagged.map((c) => card(c, 'open'))}</ul>
            </div>
          )}
          {holderCards.length > 0 && (
            <div className="space-y-1.5" data-testid="release-holders">
              <h3 className="text-meta font-medium text-ui-mute">Holding the release</h3>
              <ul className="space-y-1.5">{holderCards.map((c) => card(c, 'hold'))}</ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function MoreButton({ onClick, busy, testId, children }: { onClick: () => void; busy?: boolean; testId: string; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy === true}
      data-testid={testId}
      className={`inline-flex h-7 items-center gap-1 rounded-ui px-2 text-meta font-medium text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-9 ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

const MARK_CLASS: Record<TicketMark, string> = {
  ok: 'text-ui-success',
  blocked: 'text-ui-danger',
  held: 'text-ui-warn',
  missing: 'text-ui-warn',
  checking: 'text-ui-mute',
};

function TicketMarkIcon({ mark, anchor }: { mark: TicketMark; anchor: boolean }): JSX.Element {
  if (anchor) return <StarIcon size={12} className="shrink-0 text-ui-accent" title="The newest ticket in the release candidates" />;
  const cls = `shrink-0 ${MARK_CLASS[mark]}`;
  const title = TICKET_MARK_WORDS[mark];
  if (mark === 'ok') return <CheckIcon size={12} className={cls} title={title} />;
  if (mark === 'blocked') return <CloseIcon size={11} className={cls} title={title} />;
  if (mark === 'held') return <SkipIcon size={12} className={cls} title={title} />;
  if (mark === 'missing') return <QuestionIcon size={12} className={cls} title={title} />;
  return <PartialCircleIcon size={12} className={cls} title={title} />;
}

const LINE_CLASS = { ok: 'text-ui-success', bad: 'text-ui-danger', warn: 'text-ui-warn', unknown: 'text-ui-warn', mute: 'text-ui-mute' } as const;

/** A ticket card: mark, key, title, status, the latest tag per repository, ONE line; the rest behind the arrow. */
function TicketCard({
  card,
  check,
  ctx,
  onFocus,
  focus,
  extra,
  railed = false,
}: {
  card: TicketCardModel;
  check: ReleaseCheckResult;
  ctx: Parameters<typeof ticketCardLine>[1];
  onFocus: (h: ReleaseHolder) => void;
  focus: number | null;
  /** The candidate ticket's candidates and Release… (always shown, under its line). */
  extra?: ReactNode;
  /** In the ticket list: the mark sits on the rail at the left, not in the card. */
  railed?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus == null) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus]);
  const t = card.ticket;
  const line = ticketCardLine(card, ctx);
  const status = ticketCardStatus(t);
  const missing = card.mark === 'missing';
  const box = `min-w-0 flex-1 rounded-ui border ${
    card.isAnchor ? 'border-ui-accent bg-ui-raise' : missing ? 'border-dashed border-ui-line bg-transparent' : 'border-ui-line bg-ui-surface'
  }`;
  return (
    <li
      ref={ref}
      data-testid="release-ticket-card"
      data-key={t.key}
      data-mark={card.mark}
      data-anchor={card.isAnchor || undefined}
      className={railed ? 'relative flex gap-2.5' : box}
    >
      {railed && (
        <RailMarker tone={card.isAnchor ? 'text-ui-accent' : MARK_CLASS[card.mark]} label={card.isAnchor ? 'The newest ticket in the release candidates' : TICKET_MARK_WORDS[card.mark]}>
          <TicketMarkIcon mark={card.mark} anchor={card.isAnchor} />
        </RailMarker>
      )}
      <div className={railed ? box : 'contents'}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className={`flex cursor-pointer flex-col gap-0.5 rounded-ui px-3 py-2 hover:bg-ui-hover ${FOCUS_RING}`}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-body">
          {!railed && <TicketMarkIcon mark={card.mark} anchor={card.isAnchor} />}
          <span className={`shrink-0 font-medium ${missing ? 'text-ui-mute' : 'text-ui-ink'}`}>{t.key}</span>
          <span className={`min-w-0 truncate ${missing ? 'italic text-ui-mute' : 'text-ui-ink'}`}>{t.title ?? (missing ? 'No title — not in the tracker’s data' : '')}</span>
          {status != null && <span className="shrink-0 text-meta text-ui-mute">· {status}</span>}
          <ChevronIcon dir={open ? 'down' : 'right'} size={11} className="ml-auto shrink-0 text-ui-mute" />
        </div>
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta ${railed ? '' : 'pl-[18px]'}`}>
          {card.latest.map((r) => (
            <span key={r.repoId} className="rounded-ui bg-ui-raise px-1.5 text-ui-mute" data-testid="release-ticket-tag">
              {repoTagWords(r)}
            </span>
          ))}
          <span className={LINE_CLASS[line.tone]}>{line.text}</span>
          {line.holder != null && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFocus(line.holder!);
              }}
              className={`rounded-ui font-medium text-ui-ink underline decoration-ui-line underline-offset-2 hover:decoration-ui-ink ${FOCUS_RING}`}
            >
              Show {line.holder.key}
            </button>
          )}
        </div>
        {extra}
      </div>
      {open && <TicketCardDetail card={card} check={check} railed={railed} />}
      </div>
    </li>
  );
}

function TicketCardDetail({ card, check, railed }: { card: TicketCardModel; check: ReleaseCheckResult; railed: boolean }): JSX.Element {
  const openStory = useOpenStory();
  const t = card.ticket;
  const tracker = check.trackerName ?? 'Tracker';
  const facts: string[] = [];
  if (t.typeName != null) facts.push(`Type: ${t.typeName}`);
  if (t.assigneeName != null) facts.push(`Assignee: ${t.assigneeName}`);
  facts.push(t.readAt != null ? `${tracker} status read ${readAgoWords(t.readAt, Date.now())}` : `${tracker} status not read yet`);
  const href = t.url != null ? safeExternalUrl(t.url) : null;
  return (
    <div className={`space-y-1.5 border-t border-ui-line px-3 py-2 ${railed ? '' : 'pl-[30px]'}`} data-testid="release-ticket-detail">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-meta text-ui-mute">{facts.join(' · ')}</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {href != null && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className={`inline-flex h-7 items-center gap-1 rounded-ui px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:h-9 ${FOCUS_RING}`}
            >
              {openInTrackerWords(check.trackerName)}
              <ExternalLinkIcon size={11} />
            </a>
          )}
          <button
            type="button"
            onClick={() => openStory({ ident: t.ident, key: t.key, title: t.title })}
            className={`inline-flex h-7 items-center rounded-ui px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:h-9 ${FOCUS_RING}`}
          >
            Story
          </button>
        </span>
      </div>
      <PrLineList lines={ticketCardPrLines(t)} check={check} />
    </div>
  );
}

function PrLineList({ lines, check }: { lines: ReleasePrLine[]; check: ReleaseCheckResult }): JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <ul className="min-w-0 space-y-0.5 text-meta">
      {lines.map((l) => (
        <li key={l.key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <PrLineLink line={l} check={check} />
          <span className="min-w-0 truncate text-ui-ink">{l.title}</span>
          <span className={l.open ? 'font-medium text-ui-warn' : 'text-ui-mute'}>{l.tail}</span>
        </li>
      ))}
    </ul>
  );
}

/** A row's marker on the rail: its icon in a disc on the line (PrActivityTab's design). */
function RailMarker({ tone, label, children }: { tone: string; label: string; children: ReactNode }): JSX.Element {
  return (
    <span
      className={`relative z-10 mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ui-surface ring-1 ring-ui-line ${tone}`}
      title={label}
    >
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Pull requests with no ticket between two cards: one narrow row (a merge mark on the rail), its list behind
 *  the arrow. */
function NoTicketRow({ group, check, showBots }: { group: NoTicketGroup; check: ReleaseCheckResult; showBots: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = noTicketShownPrs(group.prs, showBots);
  const lines = shown.map((p: ReleaseCheckPr) => noTicketPrLineOf(check, p));
  return (
    <li data-testid="release-no-ticket" className="relative flex gap-2.5">
      <RailMarker tone="text-ui-mute" label="Pull requests with no ticket">
        <MergeIcon size={12} />
      </RailMarker>
      <div className="min-w-0 flex-1 pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1 rounded-ui text-meta text-ui-mute hover:text-ui-ink ${FOCUS_RING}`}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={10} className="shrink-0" />
        {noTicketGroupWords(group.prs)}
      </button>
      {open && (
        <div className="ml-4 mt-0.5">
          {lines.length > 0 ? (
            <PrLineList lines={lines} check={check} />
          ) : (
            <p className="text-meta text-ui-mute">Only bot PRs — tick “Show bot PRs” to list them.</p>
          )}
        </div>
      )}
      </div>
    </li>
  );
}

/** "backend #431": the PR tab when the PR is stored, else GitHub. */
function PrLineLink({ line, check }: { line: ReleasePrLine; check: ReleaseCheckResult }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const repo = check.repos.find((r) => r.repoId === line.repoId);
  const className = `shrink-0 rounded-ui font-medium text-ui-ink hover:underline ${FOCUS_RING}`;
  if (line.prId == null) {
    return (
      <a href={safeExternalUrl(line.url)} target="_blank" rel="noreferrer noopener" className={className}>
        {line.label}
      </a>
    );
  }
  const prId = line.prId;
  return (
    <button
      type="button"
      onClick={() =>
        openPrDetailTab(
          {
            id: prId,
            number: line.number,
            title: line.title,
            repoFullName: repo?.fullName ?? '',
            authorLogin: null,
            authorDisplayName: null,
            authorAvatarUrl: null,
          },
          { fromActivity: true },
        )
      }
      className={className}
    >
      {line.label}
    </button>
  );
}
