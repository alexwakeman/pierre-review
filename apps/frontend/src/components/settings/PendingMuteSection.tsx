import { useEffect, useMemo, useState } from 'react';
import type { WorkspacePendingMuteUpdate } from '@pierre-review/shared';
import { useWorkspaces, useWorkspaceMutations } from '../../hooks/useWorkspaces.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

/**
 * What ONE Save on this section writes. Extracted from the component so the rule can be pinned
 * without a renderer (`apps/frontend/test/pendingMutePatch.test.ts`), exactly as
 * `buildSprintPatch` is.
 *
 * ⚠ EACH HALF IS SENT ONLY WHEN IT CHANGED, even though one button submits both. The two are
 * INDEPENDENTLY OWNED FACTS, OR-ed — not a chain — so a key that rides along unchanged is an
 * assertion the user never made: it would re-write the other grain's stored value with whatever
 * this screen last read, and on a stale tab that is a silent revert of an edit made elsewhere.
 * `undefined` means "leave this fact alone", which is the whole difference between a union and
 * an inheritance chain.
 *
 * ⚠ AN EMPTY PATCH IS REACHABLE AND MUST STAY LEGAL. Save is disabled when neither half is
 * dirty, but "disabled" is a UI state, not a guarantee; `{}` is a well-formed no-op.
 *
 * ⚠ `mutedRepoIds` IS THE WHOLE SET FOR THIS WORKSPACE, never a delta. The server replaces the
 * muted set inside the named workspace's membership and leaves every other workspace's rows
 * alone — so an empty array here means "nothing in THIS workspace is muted", not "clear the
 * account".
 */
export function buildPendingMutePatch(edit: {
  workspaceDirty: boolean;
  reposDirty: boolean;
  muted: boolean;
  repoIds: number[];
}): WorkspacePendingMuteUpdate {
  const patch: WorkspacePendingMuteUpdate = {};
  if (edit.workspaceDirty) patch.muted = edit.muted;
  // Sorted so a re-order of the same set is not a different payload (the checkbox list builds it
  // in click order otherwise).
  if (edit.reposDirty) patch.mutedRepoIds = [...edit.repoIds].sort((a, b) => a - b);
  return patch;
}

/** Set equality over repo ids, order-independent — what "dirty" means for the repo half. */
function sameSet(a: readonly number[], b: ReadonlySet<number>): boolean {
  return a.length === b.size && a.every((id) => b.has(id));
}

/**
 * MUTE PENDING ITEMS for the currently-selected workspace — CORE and FREE on every tier, in both
 * deployment modes. The first free section under the modal's "Workspace" heading, and the reason
 * that heading now renders without a plugin at all.
 *
 * ── WHAT A MUTE DOES, AND WHY THE COPY LEADS WITH WHAT IT DOESN'T ────────────────────────────
 * A muted repo's items STAY ON THE PENDING BOARD. What stops is the ownership claim: the server
 * downgrades those rows to the neutral relevance, so the card reads "Review or reply" instead of
 * "Your turn"/"In your repos", the browser notification stops firing, and the "N need your
 * attention" figures (the welcome-back banner, the workspace badges, the brief strip) drop it
 * into the broader "review or reply" count. "The work is real, it is just not yours" is the rule
 * the whole board is built on — a control that HID the work would be a different, worse feature,
 * and a reader who thinks that is what this does will not use it. Hence the description says so
 * before it says anything else.
 *
 * ── TWO SWITCHES, NOT A PARENT AND A CHILD ───────────────────────────────────────────────────
 * ⚠ THE WORKSPACE TOGGLE AND THE REPO LIST ARE A UNION, NEVER A FALLBACK. A repo is muted when
 * EITHER says so. So the repo checkboxes stay ENABLED and keep their own values while the
 * workspace switch is on — disabling or clearing them would be exactly the inheritance chain this
 * model refuses (`null`-means-inherit is a named bug class here: the reviewer price, the Slack
 * target, the sprint cadence all had it). Turning the workspace switch back off must reveal the
 * per-repo choices unchanged, which it does because nothing merged them.
 *
 * ⚠ THE LIST IS THIS WORKSPACE'S MEMBERSHIP, and the Save is scoped to it server-side. The stored
 * row is repo-grained and carries no workspace id (a repo belongs to exactly one workspace
 * already), so without that scoping a Save here would clear every mute set in every other
 * workspace. Naming the workspace is the modal heading's job; naming the BLAST RADIUS is this
 * section's, and it is stated where the button is.
 */
export function PendingMuteSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const workspaces = useWorkspaces();
  const repos = useRepos();
  const { setWorkspacePendingMute } = useWorkspaceMutations();

  const workspace = workspaces.data?.find((w) => w.id === workspaceId) ?? null;
  const storedMuted = workspace?.pendingMuted ?? false;
  // The stored per-repo set, already intersected with this workspace's membership by the server.
  const storedRepoIds = useMemo(
    () => new Set(workspace?.mutedRepoIds ?? []),
    [workspace?.mutedRepoIds],
  );

  // ⚠ THE ROSTER COMES FROM `Repo.workspaceId`, THE CLIENT'S ONLY REPO→WORKSPACE MAPPING — not
  // from the timeline's repo filter, which is a Timeline-only board control that is not even
  // mounted here (the `useSearchTimeline`-on-Reports trap, one screen over).
  const memberRepos = useMemo(
    () =>
      (repos.data ?? [])
        .filter((r) => r.workspaceId === workspaceId)
        .slice()
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [repos.data, workspaceId],
  );

  const [muted, setMuted] = useState(storedMuted);
  const [repoIds, setRepoIds] = useState<number[]>([...storedRepoIds]);

  // Re-seed whenever the resolved workspace or the STORED values change — an uncontrolled seed
  // would keep the previous workspace's choices in the boxes after a switch, and Save would then
  // write them onto the new one.
  //
  // ⚠ KEYED ON THE VALUES, NOT ON THE RESPONSE OBJECT. React Query hands back a new object
  // identity on every background refetch, so a `[workspace]` dependency would revert a half-made
  // edit while the user was still in it. `storedKey` is the values, flattened.
  const storedKey = `${workspaceId}|${storedMuted}|${[...storedRepoIds].sort((a, b) => a - b).join(',')}`;
  useEffect(() => {
    setMuted(storedMuted);
    setRepoIds([...storedRepoIds]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  if (workspaceId == null || workspace == null) {
    return <ScopePendingSection title="Pending mute" failed={workspaces.isError} />;
  }

  const workspaceDirty = muted !== storedMuted;
  const reposDirty = !sameSet(repoIds, storedRepoIds);
  const dirty = workspaceDirty || reposDirty;

  const toggleRepo = (id: number): void =>
    setRepoIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));

  return (
    <SectionShell
      title="Pending mute"
      desc={
        <>
          Muted items <span className="font-medium">stay on the Pending board</span> — they just
          stop being flagged as your turn. They no longer trigger notifications and no longer
          count towards “needs your attention”; they move into the broader “review or reply”
          list. Red builds and stalled PRs are not affected.
        </>
      }
    >
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={muted}
          onChange={(e) => setMuted(e.target.checked)}
        />
        <span>
          <span className="font-medium text-gray-700 dark:text-gray-200">
            Mute this whole workspace
          </span>
          <span className="mt-0.5 block text-[11px] text-gray-400">
            Every repository in it, including ones added later.
          </span>
        </span>
      </label>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-gray-600 dark:text-gray-300">
          Mute individual repositories
        </div>
        {/* ⚠ The two switches are a UNION, not a chain — so this list stays live and keeps its own
            values while the workspace switch is on. Saying so is the difference between "these
            are already covered" and "these were cleared". */}
        {muted && (
          <p className="text-[11px] text-gray-400">
            The whole workspace is muted, so these are already covered. Their own settings are
            kept, and come back if you un-mute the workspace.
          </p>
        )}
        {repos.isLoading ? (
          <p className="text-[11px] text-gray-400">Loading this workspace’s repositories…</p>
        ) : memberRepos.length === 0 ? (
          <p className="text-[11px] text-gray-400">
            This workspace has no repositories yet.
          </p>
        ) : (
          <div className="max-h-44 space-y-1 overflow-auto rounded border border-gray-200 p-2 dark:border-gray-700">
            {memberRepos.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={repoIds.includes(r.id)}
                  onChange={() => toggleRepo(r.id)}
                />
                <span className="truncate text-gray-700 dark:text-gray-200">{r.fullName}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <SaveButton
        dirty={dirty}
        saving={setWorkspacePendingMute.isPending}
        onClick={() =>
          setWorkspacePendingMute.mutate({
            id: workspaceId,
            patch: buildPendingMutePatch({ workspaceDirty, reposDirty, muted, repoIds }),
          })
        }
      />
      <p className="text-[11px] text-gray-400">
        Applies to this workspace only. Muting a repository follows the repository, so it keeps
        its setting if you move it to another workspace.
      </p>

      {setWorkspacePendingMute.isError && (
        <div className="text-[11px] text-red-500">
          {(setWorkspacePendingMute.error as Error)?.message ?? 'Couldn’t save the mute.'}
        </div>
      )}
    </SectionShell>
  );
}
