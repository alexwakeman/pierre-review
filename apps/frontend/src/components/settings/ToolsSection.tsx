import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ToolId, ToolSwitchStatus } from '@pierre-review/shared';
import { useMe } from '../../hooks/useTriage.js';
import { useSetToolSwitch } from '../../hooks/useToolSwitches.js';
import { useAiRuntimeInstall, useAiRuntimePoll } from '../../hooks/useAiCapabilities.js';
import { startMlInstall, useMlInstallPoll, useMlInstallState } from '../../hooks/useMlInstall.js';
import { InfoButton, InfoModal } from '../InfoModal.js';
import { Button, Switch } from '../ui/index.js';
import { SectionShell } from './ui.js';

// SETTINGS → FEATURES, THE TOOLS (shared tool-switches.ts; ai/tool-switches.ts): AI and Bot comment analysis.
// THE ONE PLACE IN THE APP THAT DOWNLOADS EITHER (besides the first boot's automatic AI download and the
// CLI's `ensemble ai install` / `ensemble ml install`).
//
//   Switching ON a tool that is not downloaded asks first, in a dialog naming what and how big; Download
//   stores the switch and starts the download, Cancel leaves it off. A tool already downloaded switches on
//   at once, and the row says what is installed.
//   Switching OFF: AI reads as not set up everywhere (the files stay); bot analysis stops scoring new
//   comments (badges already shown stay, the model stays). No question: nothing is lost.
// A switch moved back to what its default says is stored as null, so it follows what is installed again.

export const TOOLS_SECTION_HEADING_ID = 'settings-tools-heading';

const DOWNLOAD: Record<ToolId, { title: string; body: string; size: string }> = {
  ai: {
    title: 'Download AI?',
    body:
      'Ensemble downloads the Claude Agent SDK and Codex into its own folder on this machine. AI Review, AI Fix and the other AI features run on them, with your own Claude or ChatGPT sign-in.',
    size: 'About 110 MB, plus about 360 MB for Codex.',
  },
  botAnalysis: {
    title: 'Download the bot comment model?',
    body:
      'Ensemble downloads two small models (ModernBERT, severity and category) and the program that runs them. They label how serious each bot review comment is, on this machine: nothing is sent anywhere.',
    size: 'About 240 MB.',
  },
};

function FoundLines({ s }: { s: ToolSwitchStatus }): JSX.Element | null {
  if (s.found.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-meta text-ui-mute" aria-label="Installed">
      {s.found.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export function ToolsSection(): JSX.Element | null {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const save = useSetToolSwitch();
  const ai = useAiRuntimeInstall();
  const mlState = useMlInstallState();
  const [asking, setAsking] = useState<ToolId | null>(null);
  useAiRuntimePoll(me?.ai?.runtime === 'installing');
  useMlInstallPoll(me?.ml?.state === 'installing' && mlState.phase !== 'running');

  const tools = me?.tools;
  if (tools == null) return null;
  // AI is offered only where it can run (not under ENSEMBLE_AI_DISABLED); bot analysis only where a
  // scorer can exist (the local model is allowed here, or a severity-api is configured).
  const showAi = me?.ai?.enabled === true;
  const showBots = me?.ml != null || tools.botAnalysis.installed;
  if (!showAi && !showBots) return null;

  const store = (id: ToolId, on: boolean): void => {
    // Back to what the default says → stored as null, so the switch follows what is installed again.
    save.mutate({ id, on: on === tools[id].defaultOn ? null : on });
  };
  const toggle = (id: ToolId, on: boolean): void => {
    if (on && !tools[id].installed) {
      setAsking(id);
      return;
    }
    store(id, on);
  };
  const download = (id: ToolId): void => {
    setAsking(null);
    save.mutate({ id, on: true });
    if (id === 'ai') ai.start(me?.ai?.provider === 'codex' ? 'codex' : undefined);
    else startMlInstall(qc);
  };

  const aiRunning = ai.state.phase === 'running' || me?.ai?.runtime === 'installing';
  const aiFailed =
    ai.state.phase === 'failed' ? (ai.state.message ?? 'The download failed.') : me?.ai?.runtime === 'failed' ? me.ai.runtimeMessage : null;
  const mlRunning = mlState.phase === 'running' || me?.ml?.state === 'installing';
  const mlFailed =
    mlState.phase === 'failed' ? (mlState.message ?? 'The download failed.') : me?.ml?.state === 'failed' ? me.ml.message : null;

  return (
    <SectionShell
      title="AI and bot comment analysis"
      headingId={TOOLS_SECTION_HEADING_ID}
      desc="Switch each on to download it; switch it off to stop using it. Downloads stay on this machine."
      info={
        <InfoButton title="AI and bot comment analysis">
          <p>
            <b>AI</b> runs AI Review, AI Fix and the other AI features. Ensemble downloads it by itself the first time it
            starts. Switched off, every AI feature shows how to set it up again, and nothing runs automatically. The
            download stays on this machine.
          </p>
          <p>
            <b>Bot comment analysis</b> labels how serious each bot review comment is. Switched off, no new comments are
            scored; the labels already shown stay, and so does the model.
          </p>
          <p>
            From a terminal: <code>npx ensemble-review ai install</code> or <code>npx ensemble-review ml install</code>.
          </p>
        </InfoButton>
      }
    >
      {showAi && (
        <div>
          <Switch
            data-testid="tool-switch-ai"
            label="AI (Claude and Codex)"
            hint={tools.ai.installed ? 'Downloaded.' : 'Not downloaded yet. Switching it on asks before downloading.'}
            checked={tools.ai.on}
            disabled={save.isPending || aiRunning}
            onChange={(e) => toggle('ai', e.target.checked)}
          />
          {aiRunning && (
            <p className="mt-1 text-meta text-ui-mute" role="status">
              Downloading AI…{ai.state.message != null ? ` ${ai.state.message}` : ''}
            </p>
          )}
          {!aiRunning && aiFailed != null && tools.ai.on && !tools.ai.installed && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ui-danger">
              {aiFailed}
              <Button size="sm" onClick={() => ai.start(me?.ai?.provider === 'codex' ? 'codex' : undefined)}>
                Retry
              </Button>
            </p>
          )}
          <FoundLines s={tools.ai} />
        </div>
      )}
      {showBots && (
        <div>
          <Switch
            data-testid="tool-switch-botAnalysis"
            label="Bot comment analysis"
            hint={
              tools.botAnalysis.installed
                ? 'Installed. Labels how serious each bot review comment is, on this machine.'
                : 'Not downloaded yet. Switching it on asks before downloading.'
            }
            checked={tools.botAnalysis.on}
            disabled={save.isPending || mlRunning}
            onChange={(e) => toggle('botAnalysis', e.target.checked)}
          />
          {mlRunning && (
            <p className="mt-1 text-meta text-ui-mute" role="status">
              Downloading the model…{mlState.message != null ? ` ${mlState.message}` : ''}
            </p>
          )}
          {!mlRunning && mlFailed != null && tools.botAnalysis.on && !tools.botAnalysis.installed && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ui-danger">
              {mlFailed}
              <Button size="sm" onClick={() => startMlInstall(qc)}>
                Retry
              </Button>
            </p>
          )}
          <FoundLines s={tools.botAnalysis} />
        </div>
      )}
      {save.isError && <div className="text-meta text-ui-danger">{save.error.message || 'Couldn’t save.'}</div>}

      {asking != null && (
        <InfoModal title={DOWNLOAD[asking].title} onClose={() => setAsking(null)} overModal>
          <p>{DOWNLOAD[asking].body}</p>
          <p className="text-ui-mute">{DOWNLOAD[asking].size}</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="primary" data-testid={`tool-download-${asking}`} onClick={() => download(asking)}>
              Download
            </Button>
          </div>
        </InfoModal>
      )}
    </SectionShell>
  );
}
