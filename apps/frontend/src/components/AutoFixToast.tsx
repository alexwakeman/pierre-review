import { autoFixRowLine, type AutoFixActiveRow } from '@pierre-review/shared';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useAutoFixActive } from '../hooks/useAiFix.js';
import { useFilters } from '../store/filters.js';
import { HeaderToast, ToastList, ToastRow } from './HeaderToasts.js';
import { WrenchIcon } from './Icons.js';

// THE AUTO FIXES TOAST (docs/CLAUDE-REVIEW.md § AI Fix → The auto fix queue): ONE circle in the ONE
// toast cluster while an AUTOMATIC fix of the workspace runs, or ended in the last two hours (shared
// AUTO_FIX_TOAST_RECENT_MS). `GET /api/pro/ai-fixes/auto-active?workspace=` (DB only), polled 10 s while
// one runs, 30 s otherwise. A failed run or a failed automatic push is the alert ring and is counted.
// A row opens the PR's AI Fix tab. A fix the reader started by a click this session is AiFixBanner's.

export function AutoFixToast(): JSX.Element | null {
  const enabled = useAiCapabilities().enabled;
  const workspaceId = useFilters((s) => s.workspaceId);
  const q = useAutoFixActive(workspaceId, enabled);
  const fixes = q.data?.fixes ?? [];
  if (!enabled || fixes.length === 0) return null;
  const running = fixes.filter((f) => f.status === 'queued' || f.status === 'running').length;
  const failed = fixes.filter((f) => f.failed).length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) parts.push(`${fixes.length} finished`);
  return (
    <HeaderToast
      testId="auto-fix-toast"
      tone="ai"
      label="Auto fixes"
      icon={<WrenchIcon size={13} className={running > 0 ? 'animate-pulse' : undefined} />}
      summary={parts.join(', ')}
      count={running > 0 ? running : failed}
      alert={failed > 0}
    >
      <ToastList>
        {fixes.map((f) => (
          <AutoFixRow key={f.fixId} f={f} />
        ))}
      </ToastList>
    </HeaderToast>
  );
}

function AutoFixRow({ f }: { f: AutoFixActiveRow }): JSX.Element {
  const openAiFix = useFilters((s) => s.openAiFix);
  const running = f.status === 'queued' || f.status === 'running';
  return (
    <ToastRow>
      <button
        type="button"
        data-testid="auto-fix-toast-row"
        onClick={() =>
          openAiFix({
            id: f.prId,
            number: f.prNumber,
            title: f.prTitle,
            repoFullName: f.repoFullName,
            authorLogin: null,
            authorDisplayName: null,
            authorAvatarUrl: null,
          })
        }
        className="hit block w-full text-left"
        title="Open the AI Fix tab for this pull request"
      >
        <div className="flex items-center gap-1.5">
          {running ? (
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-ui-line border-t-ai-signal" />
          ) : (
            <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${f.failed ? 'bg-ui-danger' : f.pushedAt != null ? 'bg-ui-success' : 'bg-ui-faint'}`} />
          )}
          <span className="truncate font-medium text-ui-ink hover:underline">
            {f.repoFullName} #{f.prNumber}
          </span>
          <span className={`ml-auto shrink-0 ${f.failed ? 'text-ui-danger' : 'text-ui-mute'}`}>{autoFixRowLine(f)}</span>
        </div>
        <div className="mt-0.5 truncate text-ui-mute">{f.prTitle}</div>
      </button>
    </ToastRow>
  );
}
