import { DetectedReviewersTable } from './DetectedReviewersTable.js';
import { useSettingsWorkspace } from './workspaceScope.js';

// Settings → Bots → "Bot classification" — every bot in this Workspace with its role (category),
// vendor and price, each changeable in place, plus "Add a review bot" (mark a reviewer this
// Workspace treats as a person as an automated reviewer). It was Bots Monitoring's Classification
// tab until 2026-11-03; the screen itself is the unchanged `DetectedReviewersTable`.
//
// A WORKSPACE section: it edits the workspace selected in the sidebar, which the modal names in its
// "Workspace" boundary above it. `workspaceId === null` (still resolving) is handled by the table,
// which renders its own loading line and never writes against a guessed scope.
export function BotClassificationSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  return <DetectedReviewersTable workspaceId={workspaceId} />;
}
