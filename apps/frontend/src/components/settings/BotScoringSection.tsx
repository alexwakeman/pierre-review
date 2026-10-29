import { useQueryClient } from '@tanstack/react-query';
import { InfoButton } from '../InfoModal.js';
import { useMe } from '../../hooks/useTriage.js';
import { ML_SETUP_LABEL, startMlInstall, useMlInstallPoll, useMlInstallState } from '../../hooks/useMlInstall.js';
import { SectionShell } from './ui.js';

// "Bot comment scoring" — the one-time download behind the severity badges on bot review comments
// (docs/ML-NODE-PORT.md). Account-level and free. Renders nothing where there is nothing to set
// up (cloud, LIMN_ML_DISABLED): `me.ml` is absent there.

export function BotScoringSection(): JSX.Element | null {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const state = useMlInstallState();
  const ml = me?.ml;
  useMlInstallPoll(ml?.state === 'installing' && state.phase !== 'running');
  if (!ml) return null;

  const running = state.phase === 'running' || ml.state === 'installing';
  const failure =
    state.phase === 'failed' ? (state.message ?? 'The download failed.') : ml.state === 'failed' ? (ml.message ?? 'The download failed.') : null;

  return (
    <SectionShell
      title="Bot comment scoring"
      desc={ml.state === 'ready' ? 'Set up. Bot review comments are scored on this machine.' : 'Score how serious each bot review comment is.'}
      info={
        <InfoButton title="Bot comment scoring">
          <p>
            A small model reads each review comment a bot leaves and labels how serious it is, from nit to critical. It
            runs on this machine: nothing is sent anywhere to score a comment.
          </p>
          <p className="mt-2">
            Setting it up downloads the model and the program that runs it, about 240 MB, once. You can also run{' '}
            <code>limn ml install</code>.
          </p>
        </InfoButton>
      }
    >
      {ml.state !== 'ready' && (
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <span className="text-meta text-ui-mute" role="status">
              Setting up…{state.message != null ? ` ${state.message}` : ''}
            </span>
          ) : (
            <>
              {failure != null && <span className="text-body text-ui-danger">{failure}</span>}
              <button
                type="button"
                onClick={() => startMlInstall(qc)}
                className="inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              >
                {failure != null ? 'Retry' : ML_SETUP_LABEL}
              </button>
            </>
          )}
        </div>
      )}
    </SectionShell>
  );
}
