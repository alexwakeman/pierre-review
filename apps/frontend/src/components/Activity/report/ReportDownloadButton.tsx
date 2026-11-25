import { Button } from '../../ui/index.js';
import { DownloadIcon } from '../../Icons.js';
import { useFilters } from '../../../store/filters.js';
import { ReportDownloadDialog } from './ReportDownloadDialog.js';

// REPORTS → "Download report" (docs/AI-ADOPTION-REPORT.md § The UI): the action in the Reports page
// header, on every Reports tab, and the dialog it opens. The open state is the pane's, so the ⌘K
// command opens the same dialog.
//
// ⚠ `workspaceId === null` means "not resolved yet": the button is hidden until it is.

export function ReportDownloadButton({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  if (workspaceId == null) return null;
  return (
    <>
      <Button size="sm" icon={<DownloadIcon size={14} />} onClick={() => onOpenChange(true)} data-testid="report-download">
        Download report
      </Button>
      {open && <ReportDownloadDialog workspaceId={workspaceId} onClose={() => onOpenChange(false)} />}
    </>
  );
}
