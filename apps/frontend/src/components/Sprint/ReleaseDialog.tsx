import { useId, useMemo, useState } from 'react';
import { releaseSnapshotOf, type CreateReleaseResponse, type ReleaseCheckResult, type ReleaseDetail } from '@pierre-review/shared';
import { useCreateRelease, useCreatingRelease, useRelease, useReleasePreview } from '../../hooks/useReleases.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { CheckIcon, CloseIcon } from '../Icons.js';
import { InfoModal } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { CheckInput, inputCls } from '../settings/ui.js';
import { confirmStops, defaultTickedRepoIds, editedSections, releasableRepos, releaseTagsLine } from './releasesModel.js';

// "CREATE RELEASE…" (docs/RELEASES.md § Releases tab 5–7). Opened by the reader's press; only then is
// the preview read (notes + comment — POST /api/releases/preview, which may write story summaries
// with the model).
//
//   • Repos, ticked. Unticking re-checks on the CLIENT through the shared `releaseSelectionProblems`
//     (`confirmStops`): a ticket that would ship in part is NAMED and Confirm is HIDDEN in its place.
//   • The notes per repo, editable (an edited section is sent; the others are built on the server).
//   • The tracker comment one ticket would get.
//   • Confirm: the server re-reads every shipped ticket and each version tag; any change STOPS it and
//     the dialog lists what changed — nothing is written. Otherwise the per-step result list.
// ⚠ The snapshot sent is what this dialog SHOWED (`releaseSnapshotOf` over the tab's check).

export function ReleaseDialog({
  workspaceId,
  check,
  onClose,
  onViewRelease,
}: {
  workspaceId: number;
  check: ReleaseCheckResult;
  onClose: () => void;
  onViewRelease: (id: number) => void;
}): JSX.Element {
  // The repos the dialog offers — fixed for its life, so the preview is read once.
  const offered = useMemo(() => releasableRepos(check), [check]);
  const offeredIds = useMemo(() => offered.map((r) => r.repoId), [offered]);
  const [ticked, setTicked] = useState<number[]>(() => defaultTickedRepoIds(check));
  const [edits, setEdits] = useState<Map<number, string>>(() => new Map());
  const preview = useReleasePreview(workspaceId, offeredIds, true);
  const create = useCreateRelease(workspaceId);
  const creating = useCreatingRelease(workspaceId);
  const stops = confirmStops(check, ticked);
  const result: CreateReleaseResponse | undefined = create.data;
  const notesId = useId();

  const toggle = (id: number): void => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const onConfirm = (): void => {
    if (preview.data == null) return;
    create.mutate({
      repoIds: ticked,
      snapshot: releaseSnapshotOf(check, ticked),
      sections: editedSections(preview.data, ticked, edits),
    });
  };

  if (result != null) {
    return (
      <InfoModal title={result.outcome === 'stopped' ? 'Release stopped' : 'Release created'} onClose={onClose} width="lg">
        {result.outcome === 'stopped' ? (
          <>
            <p>Something changed since this dialog opened. Nothing was written.</p>
            <ul className="list-disc space-y-1 pl-5">
              {result.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            <StepList detail={result.release} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => onViewRelease(result.release.id)}>
                View notes
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </InfoModal>
    );
  }

  const sections = (preview.data?.sections ?? []).filter((s) => ticked.includes(s.repoId));
  return (
    <InfoModal title="Create release" onClose={onClose} width="lg">
      <fieldset className="space-y-1.5">
        <legend className="text-meta font-medium text-ui-mute">Repositories</legend>
        {offered.map((r) => (
          <label key={r.repoId} className="flex items-center gap-2 text-body">
            <CheckInput checked={ticked.includes(r.repoId)} onChange={() => toggle(r.repoId)} disabled={creating} />
            <span className="font-medium">{r.name}</span>
            <span className="text-ui-mute">
              {r.candidate!.name} → {r.candidate!.releaseTagName}
            </span>
            {r.candidate!.releaseTagExists && <span className="text-meta text-ui-warn">already exists</span>}
          </label>
        ))}
      </fieldset>

      {preview.isLoading ? (
        <p className="text-meta text-ui-mute">Writing the release notes…</p>
      ) : preview.isError || preview.data == null ? (
        <p className="text-meta text-ui-danger">Couldn’t prepare the release notes{preview.error ? `: ${preview.error.message}` : '.'}</p>
      ) : (
        <>
          <div className="space-y-2">
            <p id={notesId} className="text-meta font-medium text-ui-mute">
              Release notes
              {preview.data.summaries.ai && preview.data.summaries.missing > 0
                ? ` · ${preview.data.summaries.missing} ${preview.data.summaries.missing === 1 ? 'story has' : 'stories have'} no summary`
                : ''}
            </p>
            {sections.map((s) => (
              <label key={s.repoId} className="block space-y-1">
                <span className="text-meta text-ui-mute">
                  {s.repoName} {s.releaseTagName}
                </span>
                <textarea
                  aria-describedby={notesId}
                  className={`${inputCls} min-h-[8rem] font-mono text-meta`}
                  value={edits.get(s.repoId) ?? s.markdown}
                  disabled={creating}
                  onChange={(e) => {
                    const v = e.target.value;
                    setEdits((m) => new Map(m).set(s.repoId, v));
                  }}
                />
              </label>
            ))}
          </div>
          {preview.data.commentPreview != null && (
            <div className="space-y-1">
              <p className="text-meta font-medium text-ui-mute">Comment on each ticket</p>
              <pre className="whitespace-pre-wrap rounded-ui bg-ui-surface px-2.5 py-2 text-meta text-ui-ink">
                {commentForTicks(preview.data.commentPreview, releaseTagsLine(check, ticked))}
              </pre>
            </div>
          )}
        </>
      )}

      {create.isError && <p className="text-meta text-ui-danger">{create.error.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {stops.length > 0 ? (
          <ul className="space-y-0.5 text-meta text-ui-warn" data-testid="release-confirm-stops">
            {stops.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        ) : (
          preview.data != null && (
            <Button variant="primary" size="sm" busy={creating} busyLabel="Checking and writing…" onClick={onConfirm}>
              Confirm
            </Button>
          )
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </InfoModal>
  );
}

/** The comment preview's tag line follows the ticks (the server's is for every offered repo). */
function commentForTicks(preview: string, tagsLine: string): string {
  const lines = preview.split('\n');
  if (lines.length >= 2 && tagsLine !== '') lines[1] = tagsLine;
  return lines.join('\n');
}

function StepList({ detail }: { detail: Pick<ReleaseDetail, 'steps' | 'items'> }): JSX.Element {
  return (
    <div className="space-y-2">
      <ul className="space-y-1" data-testid="release-steps">
        {detail.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-1.5 text-body">
            {s.ok ? (
              <CheckIcon size={12} className="mt-1 shrink-0 text-ui-success" />
            ) : (
              <CloseIcon size={11} className="mt-1 shrink-0 text-ui-danger" />
            )}
            <span>{s.text}</span>
          </li>
        ))}
      </ul>
      {detail.items.some((i) => safeExternalUrl(i.releaseUrl) != null) && (
        <ul className="space-y-0.5 text-meta">
          {detail.items.map((i) => {
            const href = safeExternalUrl(i.releaseUrl);
            return href != null ? (
              <li key={i.repoId}>
                <a href={href} target="_blank" rel="noreferrer noopener" className="text-ui-accent hover:underline">
                  {i.repoName} {i.releaseTagName} on GitHub
                </a>
              </li>
            ) : null;
          })}
        </ul>
      )}
    </div>
  );
}

/** A stored release: its steps and its notes, read when the reader opens it. */
export function ReleaseDetailModal({ id, onClose }: { id: number; onClose: () => void }): JSX.Element {
  const q = useRelease(id);
  const d = q.data;
  return (
    <InfoModal title={d != null ? `Release of ${new Date(d.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Release'} onClose={onClose} width="lg">
      {q.isLoading ? (
        <p className="text-meta text-ui-mute">Loading…</p>
      ) : q.isError || d == null ? (
        <p className="text-meta text-ui-danger">Couldn’t load this release.</p>
      ) : (
        <>
          {d.createdBy != null && <p className="text-meta text-ui-mute">Approved by {d.createdBy}</p>}
          <StepList detail={d} />
          <pre className="whitespace-pre-wrap rounded-ui bg-ui-surface px-2.5 py-2 text-meta text-ui-ink">{d.notesMarkdown}</pre>
        </>
      )}
    </InfoModal>
  );
}
