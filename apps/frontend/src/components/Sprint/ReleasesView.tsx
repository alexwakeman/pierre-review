import { useCallback, useState } from 'react';
import { releaseBlockerText, type ReleaseCheckPr, type ReleaseCheckResult, type ReleaseRepoCheck, type ReleaseTicketCheck } from '@pierre-review/shared';
import { useRefreshReleases, useReleases } from '../../hooks/useReleases.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { CheckIcon, ChevronIcon, CloseIcon, GearIcon, RefreshIcon, RocketIcon, StarIcon, WarningIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { FOCUS_RING } from '../ui/cx.js';
import { ReleaseDetailModal, ReleaseDialog } from './ReleaseDialog.js';
import {
  latestReleaseLine,
  releaseWarningText,
  releaseWordsContext,
  repoRowText,
  showCreateRelease,
  ticketRepoMark,
  ticketsPanelRows,
  type MarkTone,
} from './releasesModel.js';

// THIS SPRINT → RELEASES (docs/RELEASES.md § Releases tab) — the 4th This Sprint tab (key 4).
//
//   • Header: "Latest release: none" / "Latest release: 12 Nov", Refresh, the ⓘ with the rules,
//     "View notes" for the newest release made here, and "Create release…" (SHOWN only with a
//     candidate in a repo the reader can push to — hidden, never disabled).
//   • One row per repo ("api ★ v2.4.0 → v2.4.0-rc · 6 tickets · 1 warning"); a row expands to its
//     version tags after the release, newest first, with their pull requests and ticket chips.
//   • The tickets panel (per ticket, per repo) and the warnings, which never block.
//
// ⚠ ONE FETCH ON MOUNT: GET /api/releases (DB only). Refresh (a press) reads the held tickets again
// from the tracker (POST /api/releases/refresh) and shows the check it answers with. ⚠ Nothing renders while `workspaceId` is null.
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

  if (!data.configured || data.check == null) {
    return (
      <div data-testid="releases-view" className="flex flex-col items-center gap-3 rounded-ui bg-ui-surface px-6 py-10 text-center text-body text-ui-mute">
        <span>Set the release and hotfix suffixes to see which version tags are safe to release.</span>
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
  const busy = refresh.isPending || q.isFetching;
  const noBaseline = check.repos.filter((r) => r.noBaseline && r.status !== 'nothing_new');

  return (
    <div data-testid="releases-view" className="space-y-5 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-title text-ui-ink">{latestReleaseLine(data)}</h2>
        <InfoButton title="How releases are checked">
          <p>
            For each repository, the candidate is the newest version tag on the default branch after the last release
            whose pull requests link only to Done tickets.
          </p>
          <p>
            A ticket ships whole: every merged pull request for it, in every repository, must be in that repository’s
            candidate. An open pull request for the ticket holds it back.
          </p>
          <p>
            A pull request with no ticket is a warning, not a block. Bot pull requests with no ticket are listed under
            dependency and bot changes.
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

      {noBaseline.length > 0 && (
        <p className="text-meta text-ui-mute">
          No release yet in {noBaseline.map((r) => r.name).join(', ')}: the first release covers everything merged since
          the synced history starts. Older pull requests are not checked.
        </p>
      )}

      <section aria-label="Repositories">
        <ul className="divide-y divide-ui-line overflow-hidden rounded-ui bg-ui-surface">
          {check.repos.map((r) => (
            <RepoRow key={r.repoId} repo={r} check={check} />
          ))}
        </ul>
      </section>

      <TicketsPanel check={check} />
      <WarningsPanel check={check} />

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
  const ctx = releaseWordsContext(check);
  const expandable = repo.tags.length > 0;
  const tone = repo.status === 'candidate' ? 'text-ui-ink' : repo.status === 'blocked' ? 'text-ui-warn' : 'text-ui-mute';
  const head = (
    <>
      {expandable && <ChevronIcon dir={open ? 'down' : 'right'} size={12} className="shrink-0 text-ui-mute" />}
      <span className="font-medium text-ui-ink">{repo.name}</span>
      {repo.status === 'candidate' && <StarIcon size={12} className="shrink-0 text-ui-accent" title="Candidate" />}
      <span className={`min-w-0 ${tone}`}>{repoRowText(repo, ctx)}</span>
      {repo.candidate != null && !repo.writable && <span className="text-meta text-ui-faint">No push access</span>}
      {repo.candidate?.releaseTagExists === true && (
        <span className="text-meta text-ui-warn">{repo.candidate.releaseTagName} already exists</span>
      )}
    </>
  );
  return (
    <li data-testid="release-repo-row" data-repo={repo.name}>
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
      {open && (
        <ol className="space-y-3 px-3 pb-3 pl-8">
          {repo.tags.map((t) => (
            <li key={t.name} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-body">
                {t.isCandidate && <StarIcon size={12} className="text-ui-accent" title="Candidate" />}
                <span className="font-medium text-ui-ink">{t.name}</span>
                {t.isCandidate && <span className="text-meta text-ui-mute">candidate</span>}
                {t.blocked && t.blockers.length === 0 && <span className="text-meta text-ui-warn">held back by an older tag</span>}
                {t.moved && <span className="text-meta text-ui-warn">moved to another commit</span>}
                {t.pending && <span className="text-meta text-ui-mute">changes not read yet</span>}
              </div>
              {t.blockers.map((b, i) => (
                <p key={i} className="text-meta text-ui-warn">
                  {releaseBlockerText(b, { ...ctx, shownRepoId: repo.repoId, shownTagName: t.name })}
                </p>
              ))}
              <TagPrs prIds={t.prIds} check={check} />
              {(t.unmatchedCommits > 0 || t.truncated) && (
                <p className="text-meta text-ui-faint">
                  {t.unmatchedCommits > 0 ? `${t.unmatchedCommits} ${t.unmatchedCommits === 1 ? 'commit has' : 'commits have'} no pull request.` : ''}
                  {t.truncated ? ' Only the first commits were read.' : ''}
                </p>
              )}
              {t.prIds.length === 0 && !t.pending && <p className="text-meta text-ui-faint">No pull requests in this tag.</p>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function TagPrs({ prIds, check }: { prIds: readonly number[]; check: ReleaseCheckResult }): JSX.Element | null {
  const prById = new Map(check.prs.map((p) => [p.id, p]));
  const prs = prIds.map((id) => prById.get(id)).filter((p): p is ReleaseCheckPr => p != null);
  if (prs.length === 0) return null;
  const ticketByIdent = new Map(check.tickets.map((t) => [t.ident, t]));
  return (
    <ul className="space-y-0.5">
      {prs.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-1.5 text-body">
          <PrLink pr={p} check={check} />
          {p.ticketIdents.map((ident) => {
            const t = ticketByIdent.get(ident);
            return t != null ? <TicketChip key={ident} ticket={t} /> : null;
          })}
          {p.isBot && p.ticketIdents.length === 0 && <span className="text-meta text-ui-faint">bot</span>}
        </li>
      ))}
    </ul>
  );
}

function PrLink({ pr, check }: { pr: ReleaseCheckPr; check: ReleaseCheckResult }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const repo = check.repos.find((r) => r.repoId === pr.repoId);
  return (
    <button
      type="button"
      onClick={() =>
        openPrDetailTab(
          {
            id: pr.id,
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
      className={`min-w-0 max-w-full truncate rounded-ui text-left text-ui-ink hover:underline ${FOCUS_RING}`}
    >
      #{pr.number} {pr.title}
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

const MARK_CLASS: Record<MarkTone, string> = { ok: 'text-ui-success', bad: 'text-ui-danger', warn: 'text-ui-warn' };

function Mark({ tone }: { tone: MarkTone }): JSX.Element {
  if (tone === 'ok') return <CheckIcon size={12} className={MARK_CLASS.ok} />;
  if (tone === 'bad') return <CloseIcon size={11} className={MARK_CLASS.bad} />;
  return <WarningIcon size={12} className={MARK_CLASS.warn} />;
}

function TicketsPanel({ check }: { check: ReleaseCheckResult }): JSX.Element | null {
  const rows = ticketsPanelRows(check);
  if (rows.length === 0) return null;
  const ctx = releaseWordsContext(check);
  return (
    <section aria-labelledby="releases-tickets" className="space-y-2">
      <h3 id="releases-tickets" className="text-body font-semibold text-ui-ink">
        Tickets
      </h3>
      <ul className="divide-y divide-ui-line overflow-hidden rounded-ui bg-ui-surface">
        {rows.map((t) => (
          <li key={t.ident} className="space-y-1 px-3 py-2" data-testid="release-ticket-row">
            <div className="flex flex-wrap items-center gap-2 text-body">
              <TicketChip ticket={t} />
              {t.title != null && <span className="min-w-0 truncate text-ui-ink">{t.title}</span>}
              {t.statusName != null && <span className="text-meta text-ui-mute">{t.statusName}</span>}
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
              {t.repos.map((r) => {
                const m = ticketRepoMark(r.state);
                return (
                  <li key={r.repoId} className="inline-flex items-center gap-1 text-meta text-ui-mute">
                    <Mark tone={m.tone} />
                    <span className="text-ui-ink">{ctx.repoName(r.repoId)}</span> {m.text}
                  </li>
                );
              })}
            </ul>
            {t.blocker != null && <p className="text-meta text-ui-warn">{releaseBlockerText(t.blocker, ctx)}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WarningsPanel({ check }: { check: ReleaseCheckResult }): JSX.Element | null {
  if (check.warnings.length === 0) return null;
  return (
    <section aria-labelledby="releases-warnings" className="space-y-2">
      <h3 id="releases-warnings" className="text-body font-semibold text-ui-ink">
        Warnings
      </h3>
      <ul className="space-y-1">
        {check.warnings.map((w, i) => (
          <li key={i} className="flex items-start gap-1.5 text-body text-ui-ink">
            <WarningIcon size={12} className="mt-1 shrink-0 text-ui-warn" />
            <span>{releaseWarningText(w, check)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
