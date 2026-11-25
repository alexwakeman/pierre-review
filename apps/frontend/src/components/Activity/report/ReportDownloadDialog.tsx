import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { InfoModal } from '../../InfoModal.js';
import { AiRunGate } from '../../AiSetup.js';
import { aiReadyFor, useAiCapabilities } from '../../../hooks/useAiCapabilities.js';
import { downloadFile } from '../../../lib/downloadFile.js';
import { Button, Checkbox } from '../../ui/index.js';
import { DownloadIcon } from '../../Icons.js';
import type { BuiltReport, ReportProgress } from './buildReport.js';

// REPORTS → DOWNLOAD REPORT, the dialog (docs/AI-ADOPTION-REPORT.md § The UI; docs/FRONTEND.md
// § Reports → Download report). Three choices, a Download press, a NEUTRAL progress bar through the
// real stages, then the file saves and one line says what happened.
//
// ⚠ NOTHING IS FETCHED ON MOUNT OR ON OPEN. The figures, the renderer and the fonts load on the press.
// ⚠ ONE AbortController per build: closing the dialog (×, Escape, the backdrop, Cancel) aborts it, with
//   no toast.
// ⚠ "Write commentary with AI" shows only while `me.ai.enabled`, inside the ONE gate (`AiRunGate
//   kind="complete"`): with no credential the gate's sign-in line stands in its place. Ticked, the
//   Download button is the gate's Run control (`data-ai-run`), so the over-budget two-press holds it.
// ⚠ The report names nobody: it counts people, never who (no names on the wire at all). With AI
//   commentary, only the slide figures and tool names go to the AI provider (the server builds them;
//   the SPA sends a slide id).

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ReportProgress }
  | { kind: 'done'; line: string }
  | { kind: 'error'; line: string };

const INPUT =
  'w-full rounded-ui bg-ui-bg px-2.5 py-1.5 text-body text-ui-ink ring-1 ring-inset ring-ui-line outline-none placeholder:text-ui-faint focus:ring-2 focus:ring-ui-accent touch:min-h-10';

export function ReportDownloadDialog({ workspaceId, onClose }: { workspaceId: number; onClose: () => void }): JSX.Element {
  const aiEnabled = useAiCapabilities().enabled;
  const aiReady = aiReadyFor(useAiCapabilities(), 'complete');
  const [preparedFor, setPreparedFor] = useState('');
  const [aiTicked, setAiTicked] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const inputId = useId();
  // The box only counts while the gate shows it (AI on, a credential, the runtime ready).
  const withAi = aiEnabled && aiReady && aiTicked;

  // Unmount (the dialog closed by any route) cancels a build in flight.
  useEffect(() => () => controller.current?.abort(), []);

  const close = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    onClose();
  }, [onClose]);

  const start = async (): Promise<void> => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setPhase({ kind: 'running', progress: { pct: 0, stage: 'Fetching figures' } });
    try {
      const { buildReport, doneLine } = await import('./buildReport.js');
      const built: BuiltReport = await buildReport({
        workspaceId,
        preparedFor: preparedFor.trim(),
        aiCommentary: withAi,
        signal: c.signal,
        onProgress: (progress) => {
          if (!c.signal.aborted) setPhase({ kind: 'running', progress });
        },
      });
      if (c.signal.aborted) return;
      downloadFile(built.blob, built.filename);
      setPhase({ kind: 'done', line: doneLine(built) });
    } catch (e) {
      if (c.signal.aborted) return;
      const why = e instanceof Error && e.message !== '' ? e.message : 'something went wrong';
      setPhase({ kind: 'error', line: `The report could not be made: ${why.replace(/\.$/, '')}.` });
    } finally {
      if (controller.current === c) controller.current = null;
    }
  };

  const running = phase.kind === 'running';
  const download = (
    <Button variant="primary" icon={<DownloadIcon size={14} />} onClick={() => void start()} disabled={running} data-ai-run={withAi ? '' : undefined}>
      {phase.kind === 'done' ? 'Download again' : phase.kind === 'error' ? 'Try again' : 'Download'}
    </Button>
  );

  return (
    <InfoModal title="Download report" onClose={close}>
      <p className="text-body text-ui-mute">A PDF of slides on AI use and delivery in this workspace, made on this computer.</p>

      <fieldset disabled={running} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor={inputId} className="block text-meta text-ui-mute">
            Prepared for (optional)
          </label>
          <input
            id={inputId}
            type="text"
            value={preparedFor}
            maxLength={120}
            onChange={(e) => setPreparedFor(e.target.value)}
            placeholder="A client, a board, a team"
            className={INPUT}
            data-testid="report-prepared-for"
          />
        </div>
        {aiEnabled && (
          <div className="flex flex-wrap items-center gap-2">
            <AiRunGate kind="complete" meter={false}>
              <Checkbox
                label="Write commentary with AI"
                hint="Only the figures and tool names go to your AI provider."
                checked={aiTicked}
                onChange={(e) => setAiTicked(e.target.checked)}
                data-testid="report-ai-commentary"
              />
            </AiRunGate>
          </div>
        )}
      </fieldset>

      {phase.kind === 'running' && (
        <div className="space-y-1.5" data-testid="report-progress">
          <div
            role="progressbar"
            aria-label="Making the report"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase.progress.pct}
            className="h-2 w-full overflow-hidden rounded-full bg-ui-line"
          >
            <div className="h-full rounded-full bg-ui-accent-fill motion-safe:transition-[width] motion-safe:duration-300" style={{ width: `${phase.progress.pct}%` }} />
          </div>
          <p aria-live="polite" className="text-meta text-ui-mute" data-testid="report-stage">
            {phase.progress.stage}
          </p>
        </div>
      )}
      {phase.kind === 'done' && (
        <p aria-live="polite" className="text-body text-ui-ink" data-testid="report-done">
          {phase.line}
        </p>
      )}
      {phase.kind === 'error' && (
        <p role="alert" className="text-body text-ui-danger" data-testid="report-error">
          {phase.line}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={close}>
          {phase.kind === 'done' ? 'Close' : 'Cancel'}
        </Button>
        {withAi ? <AiRunGate kind="complete">{download}</AiRunGate> : download}
      </div>
    </InfoModal>
  );
}
