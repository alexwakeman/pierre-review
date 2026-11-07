import { useState } from 'react';
import type { TrackerProvider } from '@pierre-review/shared';
import { useCopyWorkspaceTracker, useTrackerCopySources } from '../../hooks/useWorkspaceTracker.js';
import { InfoButton } from '../InfoModal.js';
import { Button, Select } from '../ui/index.js';

const LABEL: Record<TrackerProvider, string> = { jira: 'Jira', linear: 'Linear', github: 'GitHub Issues', notion: 'Notion' };

/**
 * "Copy from another workspace" (docs/TRACKERS.md § Copying a tracker), mounted by IssueLinksSection.
 * Lists ONLY the account's other workspaces with a tracker set up — and renders nothing when there are
 * none. The copy is server-side (`POST /api/workspaces/:id/tracker/copy`): the token travels sealed
 * and never reaches this page. ⚠ ONE TRACKER PER WORKSPACE: when this workspace already has one, the
 * copy asks first (`replace: true`), and a 409 from the server asks too.
 */
export function TrackerCopyFrom({
  workspaceId,
  hasTracker,
}: {
  workspaceId: number;
  hasTracker: boolean;
}): JSX.Element | null {
  const { data } = useTrackerCopySources(workspaceId, true);
  const copy = useCopyWorkspaceTracker(workspaceId);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);

  const sources = data?.workspaceId === workspaceId ? data.sources : [];
  if (sources.length === 0) return null;
  const source = sources.find((s) => String(s.workspaceId) === picked) ?? null;

  const run = (replace: boolean): void => {
    if (source == null) return;
    setCopiedFrom(null);
    copy.mutate(
      { fromWorkspaceId: source.workspaceId, replace },
      {
        onSuccess: () => {
          setConfirming(false);
          setPicked(null);
          setCopiedFrom(source.name);
        },
        onError: (err) => {
          // The server knows of a tracker this page did not: ask, as for a known one.
          if ((err as Error & { code?: string | null }).code === 'TrackerExists') setConfirming(true);
        },
      },
    );
  };

  return (
    <div className="space-y-2 rounded-ui bg-ui-surface p-3.5" data-testid="tracker-copy-from">
      <div className="flex items-center gap-1.5">
        <h4 className="text-body font-semibold text-ui-ink">Copy from another workspace</h4>
        <InfoButton title="Copy from another workspace">
          <p>
            Copies the tracker, its address, project keys, where to look, the sign-in and the
            acceptance criteria and open points fields. The saved token is copied too; it never leaves Limn.
          </p>
          <p className="mt-2">Later changes in either workspace do not affect the other.</p>
        </InfoButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          label="Workspace to copy from"
          className="w-full sm:w-auto"
          placeholder="Choose a workspace"
          value={picked}
          onChange={(v) => {
            setPicked(v);
            setConfirming(false);
            setCopiedFrom(null);
          }}
          options={sources.map((s) => ({
            value: String(s.workspaceId),
            label: `${s.name} · ${LABEL[s.provider]}`,
          }))}
        />
        {!confirming && (
          <Button
            size="sm"
            disabled={source == null || copy.isPending}
            busy={copy.isPending}
            onClick={() => (hasTracker ? setConfirming(true) : run(false))}
          >
            Copy
          </Button>
        )}
      </div>
      {confirming && source != null && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm replace">
          <p className="text-meta text-ui-ink">Replace this workspace’s tracker with {source.name}’s?</p>
          <Button size="sm" variant="danger" busy={copy.isPending} disabled={copy.isPending} onClick={() => run(true)}>
            Replace
          </Button>
          <Button size="sm" variant="ghost" disabled={copy.isPending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
      {copiedFrom != null && <p className="text-meta text-ui-mute">Copied from {copiedFrom}.</p>}
      {copy.isError && !confirming && <p className="text-meta text-ui-danger">{copy.error.message}</p>}
    </div>
  );
}
