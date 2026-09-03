import { useFilters } from '../../store/filters.js';
import { useWorkspaces } from '../../hooks/useWorkspaces.js';
import { SectionShell } from './ui.js';

/**
 * The scope EVERY per-workspace settings section edits: the workspace currently selected in the
 * rail.
 *
 * ⚠ THERE IS NO PICKER IN SETTINGS, WHICH IS EXACTLY WHY THE NAME IS LOAD-BEARING. Slack, the
 * issue tracker and the sprint cadence are all properties of ONE team, and each section writes to
 * whichever workspace the reader happens to be in. A screen that does not SAY which workspace that
 * is, by name, is a set of controls that silently retunes the team the reader last clicked.
 *
 * ⚠ THE NAME IS NOW STATED ONCE, IN THE MODAL'S "Workspace" HEADING — NOT IN EVERY SECTION TITLE.
 * The rule changed shape when SettingsModal was split into a global half over a workspace half:
 * three headings each ending "— acme-web" was one fact three times, and it still said nothing
 * about the sections that carried no suffix. `SettingsModal` owns the naming now, as a BOUNDARY
 * rather than a suffix, so it also marks which settings are not a team's. What did NOT change is
 * the requirement itself: if a workspace-scoped control is ever mounted anywhere but under that
 * heading, it names the workspace itself or it is a control with a hidden blast radius.
 *
 * ⚠ `ScopePendingSection` BELOW IS STILL THE RIGHT ANSWER FOR A SECTION, and each one keeps its
 * guard — but the modal ALSO holds the whole half back while the scope is unresolved, because
 * three pending shells under a heading that cannot yet name anybody reads as three broken sections
 * rather than one unfinished request.
 *
 * ⚠ `workspaceId === null` MEANS "NOT RESOLVED YET", NOT "NONE". Nothing workspace-scoped may
 * render against it and nothing may be WRITTEN against it — a PUT with no `?workspace=` is
 * answered by the account's DEFAULT workspace, so a save fired during resolution lands on a team
 * the user never opened. Sections render `<ScopePendingSection>` until it lands.
 */
export function useSettingsWorkspace(): { workspaceId: number | null; name: string | null } {
  const workspaceId = useFilters((s) => s.workspaceId);
  const workspaces = useWorkspaces();
  if (workspaceId == null) return { workspaceId: null, name: null };
  // The list is still loading — the id IS resolved, so the section may render and save; it just
  // cannot name the workspace yet.
  const name = workspaces.data?.find((w) => w.id === workspaceId)?.name ?? null;
  return { workspaceId, name };
}

/** What a per-workspace section shows while the scope (or its row) has not arrived. Neutral on
 *  purpose: no fields, nothing to click, and no value that could be read as the stored one. */
export function ScopePendingSection({
  title,
  failed = false,
}: {
  title: string;
  failed?: boolean;
}): JSX.Element {
  return (
    <SectionShell title={title}>
      <p className="text-xs text-gray-400">
        {failed ? 'Unavailable right now.' : 'Loading this workspace’s settings…'}
      </p>
    </SectionShell>
  );
}
