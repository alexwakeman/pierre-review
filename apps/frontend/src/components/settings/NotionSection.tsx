import { useEffect, useId, useState } from 'react';
import { NOTION_TOKEN_RE, type WikiCredentialsSettings } from '@pierre-review/shared';
import { useCheckWikiCredentials, useSetWikiCredentials, useWikiCredentials } from '../../hooks/useReferenceDocs.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SectionShell, inputCls } from './ui.js';
import { SaveState } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const SECONDARY_BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40';

/**
 * "Notion" for THIS workspace's reference docs (CORE, local only — Settings → Docs on `me.ai.enabled`,
 * and inside the add-documents wizard; docs/REFERENCE-DOCS.md § Wiki sources → Notion). ONE write-only
 * internal-integration token; the integration must be shared with the pages in Notion (said behind the ⓘ).
 *
 * No Save button (./autosave.tsx): the token is written on blur or Enter of a non-empty, well-formed
 * value, never per keystroke; Remove writes at once. ⚠ THE TOKEN IS NEVER SHOWN (`hasToken` only).
 * ⚠ "Test connection" is CLICK-GATED (one Notion read with the SAVED token).
 */
export function NotionSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useWikiCredentials(workspaceId);
  if (workspaceId == null || q.data == null || q.data.workspaceId !== workspaceId) {
    return <ScopePendingSection title="Notion" failed={q.isError} />;
  }
  return <NotionForm key={workspaceId} workspaceId={workspaceId} saved={q.data} />;
}

export function NotionForm({ workspaceId, saved }: { workspaceId: number; saved: WikiCredentialsSettings }): JSX.Element {
  const save = useSetWikiCredentials(workspaceId);
  const check = useCheckWikiCredentials(workspaceId);
  const tokenId = useId();
  const hasToken = saved.notion?.hasToken === true;

  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  // Shown only after a commit of a malformed value — never while the reader is still typing.
  const [badShape, setBadShape] = useState(false);

  useEffect(() => {
    setToken('');
    setReplacing(false);
    setBadShape(false);
  }, [hasToken]);

  const typed = token.trim();
  const showInput = !hasToken || replacing;

  // A committed secret leaves the field at once and is never echoed (Replace closes too).
  const clearToken = (): void => {
    setToken('');
    setReplacing(false);
  };
  const commit = (): void => {
    if (typed === '' || save.isPending) return;
    if (!NOTION_TOKEN_RE.test(typed)) {
      setBadShape(true);
      return;
    }
    setBadShape(false);
    save.mutate({ notion: { token: typed } }, { onSuccess: clearToken });
  };

  return (
    <SectionShell
      title="Notion"
      desc="Add Notion pages to Docs."
      info={
        <InfoButton title="Notion">
          <div className="space-y-2">
            <p>
              Create an internal integration at notion.so/my-integrations with &ldquo;Read content&rdquo; only, and paste its
              token here. Ensemble only reads pages.
            </p>
            <p>Then share each page with the integration in Notion (the page&rsquo;s ••• menu → Connections). Its child pages are shared with it.</p>
            <p>The token is stored sealed and is never shown again.</p>
          </div>
        </InfoButton>
      }
    >
      {showInput ? (
        <Field
          label="Integration token"
          htmlFor={tokenId}
          hint={hasToken ? 'Saved when you press Enter or leave the field. It replaces the saved one.' : 'Saved when you press Enter or leave the field.'}
        >
          <input
            id={tokenId}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            placeholder="ntn_…"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setBadShape(false);
            }}
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
          <span className="font-medium text-ui-mute">Integration token</span>
          <div className="flex items-center gap-2">
            <span className="text-ui-ink">Saved</span>
            <button type="button" className={SECONDARY_BTN} onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button
              type="button"
              className={SECONDARY_BTN}
              disabled={save.isPending}
              onClick={() => save.mutate({ notion: { token: null } })}
            >
              Remove
            </button>
          </div>
        </div>
      )}
      <SaveState
        section="Notion"
        mutation={save}
        dirty={false}
        invalid={badShape ? 'a Notion token starts with ntn_ (or secret_ for an older one).' : null}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BTN} disabled={!hasToken || check.isPending} onClick={() => check.mutate('notion')}>
          {check.isPending ? 'Testing…' : 'Test connection'}
        </button>
        {!hasToken && <span className="text-meta text-ui-mute">Add a token first.</span>}
        {check.data != null && (
          <span className={`text-meta ${check.data.ok ? 'text-ui-success' : 'text-ui-danger'}`}>
            {check.data.message}
          </span>
        )}
      </div>
      {check.isError && <p className="text-body text-ui-danger">{check.error.message}</p>}
    </SectionShell>
  );
}
