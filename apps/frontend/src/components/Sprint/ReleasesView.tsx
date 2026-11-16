import { useCallback, useState, type ReactNode } from 'react';
import {
  RELEASE_OLDER_TAGS_DEFAULT,
  type ReleaseCheckPr,
  type ReleaseCheckResult,
  type ReleaseRepoCheck,
  type ReleaseTagCheck,
  type ReleaseTicketCheck,
} from '@pierre-review/shared';
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
  QuestionIcon,
  RefreshIcon,
  RocketIcon,
  StarIcon,
  WarningIcon,
} from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { FOCUS_RING } from '../ui/cx.js';
import { SprintProgressBar } from '../Activity/SprintProgressBar.js';
import { ReleaseDetailModal, ReleaseDialog } from './ReleaseDialog.js';
import {
  BAND_WORDS,
  candidateScopeLabel,
  latestReleaseLine,
  noTicketLine,
  noTicketPrLine,
  olderBandView,
  olderShowMore,
  olderTagSummary,
  openInTrackerWords,
  refreshingLine,
  repoLatestNote,
  repoProgress,
  repoRowCounts,
  repoRowText,
  rowBands,
  showCreateRelease,
  tagExplainer,
  tagHeader,
  tagTickets,
  ticketDetail,
  ticketLine,
  type MarkTone,
  type ReleasePrLine,
} from './releasesModel.js';

// THIS SPRINT → RELEASES (docs/RELEASES.md § Releases tab) — the 4th This Sprint tab (key 4).
//
//   • Header: "Latest release: none" / "Latest release: 12 Nov", Refresh, the ⓘ with the rules,
//     "View notes" for the newest release made here, and "Create release…" (SHOWN only with a
//     candidate in a repo the reader can push to — hidden, never disabled).
//   • ONE ROW PER RELEASABLE REPO: "Release 0.392.0 → 0.392.0-rc" (+ "Latest 0.394.0" when different,
//     + "6 tickets · 1 to check"), "No tag can be released — 0.394.0: BMD-1048 is In PO Review",
//     "Checking…" with a progress bar and ONE line of what the scan is doing, or "Nothing new since
//     0.390.0-rc". A row expands to ONE list, newest at the top, in THREE BANDS: every tag NEWER than
//     the candidate (always open, every ticket and reason), the CANDIDATE (open, its whole scope), and
//     OLDER tags for checking (10, one summary line each — a click opens it; "Show 50 more"; after a
//     release the band ends at "0.380.0-rc — last release"). Each tag: name · date · short sha (the
//     commit on GitHub) · PR and ticket counts. Ticket lines (✗ stops it, ? to check, ✓ Complete) open
//     in place to the detail: type, assignee, when the status was read, its PRs in this tag and
//     elsewhere, "Open in Jira" and "Story". "· 3 pull requests with no ticket" opens their list. Never
//     a block or a warning for what the reader checks. The check is automatic: nothing to pick.
//
// ⚠ ONE FETCH ON MOUNT: GET /api/releases (DB + memory only); it POLLS that same GET every ~3 s only
// while a repo is checking or its older band is read (hooks/useReleases.ts). "Show 50 more" is a press
// (POST /api/releases/older-tags); the ticket detail is in the check already (no fetch on open). Refresh (a press) reads the tickets not Complete, not read
// yet or not found again from the tracker (POST /api/releases/refresh).
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

  return (
    <div data-testid="releases-view" className="space-y-5 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-title text-ui-ink">{latestReleaseLine(data)}</h2>
        <InfoButton title="How releases are checked">
          <p>
            Only repositories ticked “Released from this workspace” in Settings are checked. Each one is checked on its
            own.
          </p>
          <p>
            Releasing a tag ships everything below it. So the candidate is the newest version tag on main where that tag
            and every tag below it have all their tickets Complete, with no pull request still open for any of them in a
            released repository. That is the tag just below the oldest tag that can’t be released. Before the first
            release every tag on main counts; after a release, only the tags since it.
          </p>
          <p>
            Tickets the tracker could not find, and pull requests with no ticket, do not stop a tag. They are listed
            under it so you can check them.
          </p>
          <p>
            Every tag newer than the candidate is listed with why it can’t be released. Older tags are listed under the
            candidate so you can check them. After a release, the list stops at that release.
          </p>
          <p>Create release tags each candidate with the release suffix, publishes the notes and comments on each ticket.</p>
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
          {showCreateRelease(check) && (
            <Button size="sm" variant="primary" icon={<RocketIcon size={13} />} onClick={() => setDialogOpen(true)}>
              Create release…
            </Button>
          )}
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

      <section aria-label="Repositories">
        <ul className="divide-y divide-ui-line overflow-hidden rounded-ui bg-ui-surface">
          {check.repos.map((r) => (
            <RepoRow key={r.repoId} repo={r} check={check} workspaceId={workspaceId} />
          ))}
        </ul>
      </section>

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

function RepoRow({ repo, check, workspaceId }: { repo: ReleaseRepoCheck; check: ReleaseCheckResult; workspaceId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const counts = repoRowCounts(repo);
  const latest = repoLatestNote(repo);
  const progress = repoProgress(repo);
  const expandable = repo.tags.length > 0;
  const tone = repo.status === 'candidate' ? 'text-ui-ink' : repo.status === 'none' ? 'text-ui-warn' : 'text-ui-mute';
  const head = (
    <>
      {expandable && <ChevronIcon dir={open ? 'down' : 'right'} size={12} className="shrink-0 text-ui-mute" />}
      <span className="font-medium text-ui-ink">{repo.name}</span>
      {repo.status === 'candidate' && <StarIcon size={12} className="shrink-0 text-ui-accent" title="Candidate" />}
      <span className={`min-w-0 ${tone}`}>{repoRowText(repo)}</span>
      {latest != null && <span className="text-meta text-ui-mute">{latest}</span>}
      {counts != null && <span className="text-meta text-ui-mute">{counts}</span>}
      {repo.candidate != null && !repo.writable && <span className="text-meta text-ui-faint">No push access</span>}
      {repo.candidate?.releaseTagExists === true && (
        <span className="text-meta text-ui-warn">{repo.candidate.releaseTagName} already exists</span>
      )}
    </>
  );
  return (
    <li data-testid="release-repo-row" data-repo={repo.name} data-status={repo.status}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-body hover:bg-ui-hover ${FOCUS_RING}`}
        >
          {head}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-body">{head}</div>
      )}
      {progress != null && (
        <div className="flex items-center gap-2 px-3 pb-2 pl-8" data-testid="release-progress">
          <SprintProgressBar
            progress={{ kind: 'share', label: progress.line ?? 'Checking', value: progress.share }}
            className="h-1.5 w-40 shrink-0 rounded-full"
            testId="release-progress-bar"
          />
          {progress.line != null && <span className="min-w-0 text-meta text-ui-mute">{progress.line}</span>}
        </div>
      )}
      {open && <RepoDetail repo={repo} check={check} workspaceId={workspaceId} />}
    </li>
  );
}

function RepoDetail({ repo, check, workspaceId }: { repo: ReleaseRepoCheck; check: ReleaseCheckResult; workspaceId: number }): JSX.Element {
  const bands = rowBands(repo);
  // The reader's count of older tags (10, then +50 a press). Component state: not persisted.
  const [shown, setShown] = useState(RELEASE_OLDER_TAGS_DEFAULT);
  const more = useShowMoreOlderTags(workspaceId);
  const older = olderBandView(repo, shown);
  const onMore = (): void => {
    const next = olderShowMore(shown, repo.older.wanted);
    setShown(next.shown);
    if (next.ask != null) more.mutate({ repoId: repo.repoId, wanted: next.ask });
  };
  return (
    <div className="space-y-4 px-3 pb-3 pl-8" data-testid="release-repo-detail">
      {repo.tags.length === 0 && <p className="text-meta text-ui-mute">No version tags after {repo.baseline?.name ?? 'the start'}.</p>}
      {bands.newerHeading != null && (
        <Band label={bands.newerHeading} testId="release-band-newer">
          {bands.newer.map((t) => (
            <TagBlock key={t.name} tag={t} repo={repo} check={check} />
          ))}
        </Band>
      )}
      {bands.candidate != null && (
        <Band label={BAND_WORDS.candidate} testId="release-band-candidate">
          <TagBlock tag={bands.candidate} repo={repo} check={check} />
        </Band>
      )}
      {bands.candidate != null && (older.tags.length > 0 || older.progress != null || older.lastReleaseLine != null) && (
        <Band label={BAND_WORDS.older} testId="release-band-older">
          {older.tags.map((t) => (
            <OlderTag key={t.name} tag={t} repo={repo} check={check} />
          ))}
          {older.lastReleaseLine != null && (
            <li className="text-meta text-ui-mute" data-testid="release-last-release">
              {older.lastReleaseLine}
            </li>
          )}
          {older.progress != null && (
            <li className="flex items-center gap-2" data-testid="release-older-progress">
              <SprintProgressBar
                progress={{ kind: 'share', label: older.progress.line ?? 'Reading', value: older.progress.share }}
                className="h-1.5 w-40 shrink-0 rounded-full"
                testId="release-older-progress-bar"
              />
              {older.progress.line != null && <span className="min-w-0 text-meta text-ui-mute">{older.progress.line}</span>}
            </li>
          )}
          {(older.shownLine != null || older.showMore) && (
            <li className="flex flex-wrap items-center gap-2">
              {older.shownLine != null && <span className="text-meta text-ui-mute">{older.shownLine}</span>}
              {older.showMore && (
                <Button size="sm" variant="ghost" onClick={onMore} busy={more.isPending} busyLabel="Asking…">
                  Show 50 more
                </Button>
              )}
            </li>
          )}
          {more.isError && <li className="text-meta text-ui-danger">Couldn’t ask for more tags. Try again.</li>}
        </Band>
      )}
    </div>
  );
}

function Band({ label, testId, children }: { label: string; testId: string; children: ReactNode }): JSX.Element {
  return (
    <section data-testid={testId} className="space-y-2">
      <h3 className="text-meta font-medium uppercase tracking-wide text-ui-mute">{label}</h3>
      <ol className="space-y-3 border-l border-ui-line pl-3">{children}</ol>
    </section>
  );
}

function TagHeaderLine({ tag, repo, check }: { tag: ReleaseTagCheck; repo: ReleaseRepoCheck; check: ReleaseCheckResult }): JSX.Element {
  const h = tagHeader(check, tag);
  const href = safeExternalUrl(h.url);
  return (
    <>
      {tag.isCandidate && <StarIcon size={12} className="shrink-0 text-ui-accent" title="Candidate" />}
      <span className="font-medium text-ui-ink">{h.name}</span>
      {h.day != null && <span className="text-meta text-ui-mute">· {h.day}</span>}
      <span className="text-meta text-ui-mute">·</span>
      {href != null ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className={`rounded-ui font-mono text-meta text-ui-ink hover:underline ${FOCUS_RING}`}
          title="Open the commit on GitHub"
        >
          {h.shortSha}
        </a>
      ) : (
        <span className="font-mono text-meta text-ui-mute">{h.shortSha}</span>
      )}
      <span className="text-meta text-ui-mute">· {h.counts}</span>
      {tag.isCandidate && <span className="text-meta text-ui-mute">· {candidateScopeLabel(repo)}</span>}
      {tag.state === 'checking' && !tag.isCandidate && <span className="text-meta text-ui-warn">· checking</span>}
      {tag.moved && <span className="text-meta text-ui-warn">· moved to another commit</span>}
    </>
  );
}

/** A tag in the newer or candidate band: always open — its header, every ticket, its notes. */
function TagBlock({ tag, repo, check }: { tag: ReleaseTagCheck; repo: ReleaseRepoCheck; check: ReleaseCheckResult }): JSX.Element {
  return (
    <li className="space-y-1" data-testid="release-tag" data-tag={tag.name} data-band={tag.band}>
      <div className="flex flex-wrap items-center gap-1.5 text-body">
        <TagHeaderLine tag={tag} repo={repo} check={check} />
      </div>
      <TagBody tag={tag} check={check} />
    </li>
  );
}

/** An older tag: ONE summary line; a click opens its tickets. */
function OlderTag({ tag, repo, check }: { tag: ReleaseTagCheck; repo: ReleaseRepoCheck; check: ReleaseCheckResult }): JSX.Element {
  const [open, setOpen] = useState(false);
  const sum = olderTagSummary(check, tag);
  return (
    <li className="space-y-1" data-testid="release-tag" data-tag={tag.name} data-band="older">
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
        className={`flex cursor-pointer flex-wrap items-center gap-1.5 rounded-ui text-body hover:bg-ui-hover ${FOCUS_RING}`}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={12} className="shrink-0 text-ui-mute" />
        <TagHeaderLine tag={tag} repo={repo} check={check} />
        <span className="inline-flex items-center gap-1 text-meta">
          <Mark tone={sum.tone} />
          <span className={sum.tone === 'ok' ? 'text-ui-mute' : MARK_CLASS[sum.tone]}>{sum.text}</span>
        </span>
      </div>
      {open && <TagBody tag={tag} check={check} />}
    </li>
  );
}

function TagBody({ tag, check }: { tag: ReleaseTagCheck; check: ReleaseCheckResult }): JSX.Element {
  const c = tagTickets(check, tag);
  const lines = tagExplainer(tag);
  const noTicket = noTicketLine(c.noTicket.length);
  return (
    <div className="space-y-1">
      {lines.map((l, i) => (
        <p key={i} className={`text-meta ${l.tone === 'ok' ? 'text-ui-mute' : MARK_CLASS[l.tone]}`}>
          {l.text}
        </p>
      ))}
      {c.tickets.length > 0 && (
        <ul className="space-y-0.5">
          {c.tickets.map(({ ticket }) => (
            <TicketLine key={ticket.ident} ticket={ticket} tag={tag} check={check} />
          ))}
        </ul>
      )}
      {noTicket != null && <NoTicketList label={noTicket} prs={c.noTicket} check={check} />}
      {tag.unmatchedCommits > 0 && (
        <p className="text-meta text-ui-mute">
          {tag.unmatchedCommits} {tag.unmatchedCommits === 1 ? 'commit has' : 'commits have'} no pull request.
        </p>
      )}
      {tag.prIds.length === 0 && tag.historyRead && !tag.isCandidate && <p className="text-meta text-ui-mute">No pull requests in this tag.</p>}
    </div>
  );
}

const MARK_CLASS: Record<MarkTone, string> = { ok: 'text-ui-success', bad: 'text-ui-danger', warn: 'text-ui-warn', unknown: 'text-ui-warn' };

function Mark({ tone }: { tone: MarkTone }): JSX.Element {
  if (tone === 'ok') return <CheckIcon size={12} className={`shrink-0 ${MARK_CLASS.ok}`} />;
  if (tone === 'bad') return <CloseIcon size={11} className={`shrink-0 ${MARK_CLASS.bad}`} />;
  if (tone === 'unknown') return <QuestionIcon size={12} className={`shrink-0 ${MARK_CLASS.unknown}`} />;
  return <WarningIcon size={12} className={`shrink-0 ${MARK_CLASS.warn}`} />;
}

function TicketLine({ ticket, tag, check }: { ticket: ReleaseTicketCheck; tag: ReleaseTagCheck; check: ReleaseCheckResult }): JSX.Element {
  const [open, setOpen] = useState(false);
  const m = ticketLine(ticket, check.trackerName);
  return (
    <li data-testid="release-ticket" data-key={ticket.key}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full flex-wrap items-center gap-1.5 rounded-ui text-left text-body hover:bg-ui-hover ${FOCUS_RING}`}
      >
        <Mark tone={m.tone} />
        <span className="font-medium text-ui-ink">{ticket.key}</span>
        {ticket.title != null && <span className="min-w-0 truncate text-ui-ink">{ticket.title}</span>}
        <span className={`text-meta ${m.tone === 'ok' ? 'text-ui-mute' : MARK_CLASS[m.tone]}`}>{m.text}</span>
      </button>
      {open && <TicketDetailBlock ticket={ticket} tag={tag} check={check} />}
    </li>
  );
}

function TicketDetailBlock({ ticket, tag, check }: { ticket: ReleaseTicketCheck; tag: ReleaseTagCheck; check: ReleaseCheckResult }): JSX.Element {
  const openStory = useOpenStory();
  const d = ticketDetail(check, tag, ticket, Date.now());
  const href = ticket.url != null ? safeExternalUrl(ticket.url) : null;
  return (
    <div className="ml-5 mt-1 space-y-1.5 rounded-ui bg-ui-raise px-3 py-2" data-testid="release-ticket-detail">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-meta text-ui-mute">{d.facts.join(' · ')}</span>
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
            onClick={() => openStory({ ident: ticket.ident, key: ticket.key, title: ticket.title })}
            className={`inline-flex h-7 items-center rounded-ui px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:h-9 ${FOCUS_RING}`}
          >
            Story
          </button>
        </span>
      </div>
      <PrLines label="In this tag" lines={d.inThisTag} check={check} />
      <PrLines label="Elsewhere" lines={d.elsewhere} check={check} />
    </div>
  );
}

function PrLines({ label, lines, check }: { label: string; lines: ReleasePrLine[]; check: ReleaseCheckResult }): JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta">
      <span className="text-ui-mute">{label}</span>
      <ul className="min-w-0 space-y-0.5">
        {lines.map((l) => (
          <li key={l.key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <PrLineLink line={l} check={check} />
            <span className="min-w-0 truncate text-ui-ink">{l.title}</span>
            <span className={l.open ? 'font-medium text-ui-warn' : 'text-ui-mute'}>{l.tail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoTicketList({ label, prs, check }: { label: string; prs: ReleaseCheckPr[]; check: ReleaseCheckResult }): JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = prs.map((p) => noTicketPrLine(check, p));
  return (
    <div className="space-y-0.5" data-testid="release-no-ticket">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1 rounded-ui text-meta text-ui-mute hover:text-ui-ink ${FOCUS_RING}`}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={10} className="shrink-0" />· {label}
      </button>
      {open && (
        <ul className="ml-4 space-y-0.5 text-meta">
          {lines.map((l) => (
            <li key={l.key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <PrLineLink line={l} check={check} />
              <span className="min-w-0 truncate text-ui-ink">{l.title}</span>
              <span className="text-ui-mute">{l.tail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
