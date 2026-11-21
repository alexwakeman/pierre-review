import { useEffect, useId, useState } from 'react';
import type { WorkspaceFigmaSettings } from '@pierre-review/shared';
import { useCheckWorkspaceFigma, useUpdateWorkspaceFigma, useWorkspaceFigma } from '../../hooks/useFigma.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SectionShell, inputCls } from './ui.js';
import { SaveState } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const SECONDARY_BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40';

/**
 * "Figma" for THIS workspace (docs/IMPLEMENT-UI-PLAN.md § 3): an optional, WRITE-ONLY personal access token. With
 * it, an Implement build reads the Figma frames its ticket links. The token is written on blur or Enter of a
 * non-empty value, never per keystroke; Remove writes at once. ⚠ NEVER SHOWN (`hasToken` only). "Test token" is
 * CLICK-GATED (it calls Figma).
 */
export function FigmaSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useWorkspaceFigma(workspaceId);
  if (workspaceId == null || q.data == null || q.data.workspaceId !== workspaceId) return <ScopePendingSection title="Figma" failed={q.isError} />;
  return <FigmaForm key={workspaceId} workspaceId={workspaceId} saved={q.data} />;
}

function FigmaForm({ workspaceId, saved }: { workspaceId: number; saved: WorkspaceFigmaSettings }): JSX.Element {
  const save = useUpdateWorkspaceFigma(workspaceId);
  const check = useCheckWorkspaceFigma(workspaceId);
  const id = useId();
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  useEffect(() => {
    setToken('');
    setReplacing(false);
  }, [saved.hasToken]);
  const typed = token.trim();
  const commit = (): void => {
    if (typed === '' || save.isPending) return;
    save.mutate({ token: typed }, { onSuccess: () => (setToken(''), setReplacing(false)) });
  };
  const result = check.data?.workspaceId === workspaceId ? check.data : null;

  return (
    <SectionShell
      title="Figma"
      desc="Let Implement story read the Figma frames a ticket links."
      info={
        <InfoButton title="Figma">
          <div className="space-y-2">
            <p>
              Create a personal access token in Figma under Settings → Security, with read access to file content. When a
              ticket links a Figma frame, Ensemble reads it for the build: an outline of its layers and a picture of it.
              It only reads.
            </p>
            <p>Without a token, the agent works from the ticket's other files and says so in the plan.</p>
            <p>The token is stored sealed and is never shown again.</p>
          </div>
        </InfoButton>
      }
    >
      {!saved.hasToken || replacing ? (
        <Field label="Token" htmlFor={id} hint={saved.hasToken ? 'Saved when you press Enter or leave the field. It replaces the saved one.' : 'Saved when you press Enter or leave the field.'}>
          <input
            id={id}
            data-testid="figma-token"
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1 text-body">
          <span className="font-medium text-ui-mute">Token</span>
          <div className="flex items-center gap-2">
            <span data-testid="figma-token-saved" className="text-ui-ink">{saved.tokenUnreadable ? 'Saved, but unreadable here. Replace it.' : 'Saved'}</span>
            <button type="button" className={SECONDARY_BTN} onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button type="button" className={SECONDARY_BTN} disabled={save.isPending} onClick={() => save.mutate({ clearToken: true })}>
              Remove
            </button>
          </div>
        </div>
      )}
      <SaveState section="Figma token" mutation={save} dirty={false} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BTN} disabled={!saved.hasToken || check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? 'Testing…' : 'Test token'}
        </button>
        {result != null && <span className={`text-meta ${result.ok ? 'text-ui-success' : 'text-ui-danger'}`}>{result.message}</span>}
      </div>
      {check.isError && <p className="text-body text-ui-danger">{check.error.message}</p>}
      <p className="text-meta text-ui-faint">Applies to this workspace only.</p>
    </SectionShell>
  );
}
