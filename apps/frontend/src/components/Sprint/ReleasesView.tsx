import { useCallback, useState } from 'react';
import type { ReleaseCheckPr, ReleaseCheckResult, ReleaseRepoCheck, ReleaseTicketCheck } from '@pierre-review/shared';
import { useRefreshReleases, useReleases } from '../../hooks/useReleases.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { CheckIcon, ChevronIcon, CloseIcon, GearIcon, RefreshIcon, RocketIcon, StarIcon, WarningIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { FOCUS_RING } from '../ui/cx.js';
import { SprintProgressBar } from '../Activity/SprintProgressBar.js';
import { ReleaseDetailModal, ReleaseDialog } from './ReleaseDialog.js';
import {
  expandedTags,
  latestReleaseLine,
  noTicketLine,
  repoLatestNote,
  repoProgress,
  repoRowCounts,
  repoRowText,
  showCreateRelease,
  tagContents,
  tagExplainer,
  ticketMark,
  type MarkTone,
} from './releasesModel.js';

// THIS SPRINT → RELEASES (docs/RELEASES.md § Releases tab) — the 4th This Sprint tab (key 4).
//
//   • Header: "Latest release: none" / "Latest release: 12 Nov", Refresh, the ⓘ with the rules,
//     "View notes" for the newest release made here, and "Create release…" (SHOWN only with a
//     candidate in a repo the reader can push to — hidden, never disabled).
//   • ONE ROW PER RELEASABLE REPO: "Release 0.392.0 → 0.392.0-rc" (+ "Latest 0.394.0" when different,
//     + "6 tickets · 1 to check"), "No tag can be released — 0.394.0: BMD-1048 is In PO Review",
//     "Checking…" with a progress bar and ONE line of what the scan is doing, or "Nothing new since
//     0.390.0-rc". A row expands to the tags read, newest first: each tag newer than the candidate with
//     why it does not qualify ("BMD-1040 (from 0.391.0) is In Progress."), then the candidate with the
//     tickets of its scope. Under each tag: tickets the tracker could not give ("BMD-123 not found") and
//     pull requests with no ticket — for the reader to check, never a block or a warning. The check is
//     automatic: there is nothing to pick.
//
// ⚠ ONE FETCH ON MOUNT: GET /api/releases (DB + memory only); it POLLS that same GET every ~3 s only
// while a repo is checking (hooks/useReleases.ts). Refresh (a press) reads the tickets not Complete, not read
// yet or not found again from the tracker (POST /api/releases/refresh).
// ⚠ Nothing renders while `workspaceId` is null. Not configured, or no repo ticked "Released from this
// workspace": ONE setup line linking to Settings → Releases.
// ⚠ A ticket chip opens the story through `useOpenStory()`; a pull request opens its PR tab.

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
            The candidate is the newest version tag on main whose tickets are all Complete, with no pull request still
            open for any of them in a released repository. After a release, a tag’s tickets are everything merged since
            that release; before the first release, only what the tag itself added.
          </p>
          <p>
            Tickets the tracker could not find, and pull requests with no ticket, do not stop a tag. They are listed
            under it so you can check them.
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

      {refresh.isError && <p className="text-meta text-ui-danger">Couldn’t refresh. Try again.</p>}
      {refresh.data != null && refresh.data.unread.length > 0 && (
        <p className="text-meta text-ui-mute">The tracker did not answer for {refresh.data.unread.join(', ')}.</p>
      )}

      <section aria-label="Repositories">
        <ul className="divide-y divide-ui-line overflow-hidden rounded-ui bg-ui-surface">
          {check.repos.map((r) => (
            <RepoRow key={r.repoId} repo={r} check={check} />
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

function RepoRow({ repo, check }: { repo: ReleaseRepoCheck; check: ReleaseCheckResult }): JSX.Element {
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
      {open && <RepoDetail repo={repo} check={check} />}
    </li>
  );
}

function RepoDetail({ repo, check }: { repo: ReleaseRepoCheck; check: ReleaseCheckResult }): JSX.Element {
  const tags = expandedTags(repo);
  return (
    <div className="space-y-3 px-3 pb-3 pl-8">
      {tags.length === 0 && <p className="text-meta text-ui-faint">No version tags after {repo.baseline?.name ?? 'the start'}.</p>}
      <ol className="space-y-3">
        {tags.map((t) => {
          const c = tagContents(check, t);
          const lines = tagExplainer(t);
          return (
            <li key={t.name} className="space-y-1" data-testid="release-tag" data-tag={t.name}>
              <div className="flex flex-wrap items-center gap-2 text-body">
                {t.isCandidate && <StarIcon size={12} className="text-ui-accent" title="Candidate" />}
                <span className="font-medium text-ui-ink">{t.name}</span>
                {t.isCandidate && (
                  <span className="text-meta text-ui-mute">
                    {repo.baseline != null ? `candidate · everything since ${repo.baseline.name}` : 'candidate · this tag’s own changes'}
                  </span>
                )}
                {t.state === 'checking' && <span className="text-meta text-ui-mute">checking</span>}
                {t.moved && <span className="text-meta text-ui-warn">moved to another commit</span>}
              </div>
              {lines.map((l, i) => (
                <p key={i} className={`text-meta ${l.tone === 'bad' ? 'text-ui-danger' : l.tone === 'warn' ? 'text-ui-warn' : 'text-ui-mute'}`}>
                  {l.text}
                </p>
              ))}
              {c.tickets.length > 0 && (
                <ul className="space-y-0.5">
                  {c.tickets.map(({ ticket, prs }) => (
                    <TicketLine key={ticket.ident} ticket={ticket} prs={prs} check={check} />
                  ))}
                </ul>
              )}
              {c.noTicket.length > 0 && <PrList label={noTicketLine(c.noTicket.length)!} prs={c.noTicket} check={check} />}
              {t.unmatchedCommits > 0 && (
                <p className="text-meta text-ui-faint">
                  {t.unmatchedCommits} {t.unmatchedCommits === 1 ? 'commit has' : 'commits have'} no pull request.
                </p>
              )}
              {t.prIds.length === 0 && t.historyRead && <p className="text-meta text-ui-faint">No pull requests in this tag.</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const MARK_CLASS: Record<MarkTone, string> = { ok: 'text-ui-success', bad: 'text-ui-danger', warn: 'text-ui-warn' };

function Mark({ tone }: { tone: MarkTone }): JSX.Element {
  if (tone === 'ok') return <CheckIcon size={12} className={`shrink-0 ${MARK_CLASS.ok}`} />;
  if (tone === 'bad') return <CloseIcon size={11} className={`shrink-0 ${MARK_CLASS.bad}`} />;
  return <WarningIcon size={12} className={`shrink-0 ${MARK_CLASS.warn}`} />;
}

function TicketLine({ ticket, prs, check }: { ticket: ReleaseTicketCheck; prs: ReleaseCheckPr[]; check: ReleaseCheckResult }): JSX.Element {
  const m = ticketMark(ticket);
  return (
    <li className="flex flex-wrap items-center gap-1.5 text-body" data-testid="release-ticket">
      <Mark tone={m.tone} />
      <TicketChip ticket={ticket} />
      {ticket.title != null && <span className="min-w-0 truncate text-ui-ink">{ticket.title}</span>}
      <span className={`text-meta ${m.tone === 'ok' ? 'text-ui-mute' : MARK_CLASS[m.tone]}`}>{m.text}</span>
      {prs.map((p) => (
        <PrLink key={p.id} pr={p} check={check} short />
      ))}
    </li>
  );
}

function PrList({ label, prs, check }: { label: string; prs: ReleaseCheckPr[]; check: ReleaseCheckResult }): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-body">
      <span className="text-meta text-ui-mute">{label}</span>
      <ul className="min-w-0 space-y-0.5">
        {prs.map((p) => (
          <li key={p.id}>
            <PrLink pr={p} check={check} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrLink({ pr, check, short = false }: { pr: ReleaseCheckPr; check: ReleaseCheckResult; short?: boolean }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const repo = check.repos.find((r) => r.repoId === pr.repoId);
  const className = `min-w-0 max-w-full truncate rounded-ui text-left text-ui-ink hover:underline ${short ? 'text-meta' : ''} ${FOCUS_RING}`;
  // A PR older than the synced history is only a light record: it opens on GitHub.
  if (pr.prId == null) {
    return (
      <a href={safeExternalUrl(pr.url)} target="_blank" rel="noreferrer noopener" title={short ? pr.title : undefined} className={className}>
        #{pr.number}
        {short ? '' : ` ${pr.title}`}
      </a>
    );
  }
  const prId = pr.prId;
  return (
    <button
      type="button"
      title={short ? pr.title : undefined}
      onClick={() =>
        openPrDetailTab(
          {
            id: prId,
            number: pr.number,
            title: pr.title,
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
      #{pr.number}
      {short ? '' : ` ${pr.title}`}
    </button>
  );
}

function TicketChip({ ticket }: { ticket: Pick<ReleaseTicketCheck, 'ident' | 'key' | 'title'> }): JSX.Element {
  const openStory = useOpenStory();
  return (
    <button
      type="button"
      onClick={() => openStory({ ident: ticket.ident, key: ticket.key, title: ticket.title })}
      className={`inline-flex h-6 items-center rounded-ui bg-ui-raise px-1.5 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:h-9 ${FOCUS_RING}`}
    >
      {ticket.key}
    </button>
  );
}
