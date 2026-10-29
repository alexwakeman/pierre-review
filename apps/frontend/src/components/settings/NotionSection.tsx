import { useEffect, useId, useState } from 'react';
import { NOTION_TOKEN_RE, type WikiCredentialsSettings } from '@pierre-review/shared';
import { useCheckWikiCredentials, useSetWikiCredentials, useWikiCredentials } from '../../hooks/useReferenceDocs.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const SECONDARY_BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/**
 * "Notion" for THIS workspace's reference docs (CORE, local only — mounted beside Confluence on
 * `me.ai.enabled`; docs/REFERENCE-DOCS.md § Wiki sources → Notion). ONE write-only internal-integration
 * token; the integration must be shared with the pages in Notion (said behind the ⓘ).
 *
 * ⚠ DRAFT + SAVE like every section here. ⚠ THE TOKEN IS NEVER SHOWN (`hasToken` only). ⚠ "Test
 * connection" is CLICK-GATED (one Notion read with the SAVED token).
 */
export function NotionSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useWikiCredentials(workspaceId);
  if (workspaceId == null || q.data == null || q.data.workspaceId !== workspaceId) {
    return <ScopePendingSection title="Notion" failed={q.isError} />;
  }
  return <NotionForm key={workspaceId} workspaceId={workspaceId} saved={q.data} />;
}

function NotionForm({ workspaceId, saved }: { workspaceId: number; saved: WikiCredentialsSettings }): JSX.Element {
  const save = useSetWikiCredentials(workspaceId);
  const check = useCheckWikiCredentials(workspaceId);
  const tokenId = useId();
  const hasToken = saved.notion?.hasToken === true;

  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    setToken('');
    setReplacing(false);
    setRemoving(false);
  }, [hasToken]);

  const typed = token.trim();
  const shapeOk = typed === '' || NOTION_TOKEN_RE.test(typed);
  const dirty = typed !== '' || removing;
  const showInput = (!hasToken || replacing) && !removing;

  const onSave = (): void => {
    save.mutate({ notion: { token: removing ? null : typed } });
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
              token here. Limn only reads pages.
            </p>
            <p>Then share each page with the integration in Notion (the page&rsquo;s ••• menu → Connections). Its child pages are shared with it.</p>
            <p>The token is stored sealed and is never shown again.</p>
          </div>
        </InfoButton>
      }
    >
      {showInput ? (
        <Field label="Integration token" htmlFor={tokenId} hint={hasToken ? 'Replaces the saved token when you save.' : undefined}>
          <input
            id={tokenId}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            placeholder="ntn_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-gray-600 dark:text-gray-300">Integration token</span>
          <div className="flex items-center gap-2">
            <span className="text-gray-700 dark:text-gray-200">{removing ? 'Removed when you save' : 'Saved'}</span>
            {removing ? (
              <button type="button" className={SECONDARY_BTN} onClick={() => setRemoving(false)}>
                Keep it
              </button>
            ) : (
              <>
                <button type="button" className={SECONDARY_BTN} onClick={() => setReplacing(true)}>
                  Replace
                </button>
                <button type="button" className={SECONDARY_BTN} onClick={() => setRemoving(true)}>
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {!shapeOk && <p className="text-[11px] text-red-600 dark:text-red-400">A Notion token starts with ntn_ (or secret_ for an older one).</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BTN} disabled={!hasToken || dirty || check.isPending} onClick={() => check.mutate('notion')}>
          {check.isPending ? 'Testing…' : 'Test connection'}
        </button>
        {dirty && <span className="text-[11px] text-gray-500 dark:text-gray-400">Save first.</span>}
        {check.data != null && (
          <span className={`text-[11px] ${check.data.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {check.data.message}
          </span>
        )}
      </div>
      {check.isError && <p className="text-xs text-red-600 dark:text-red-400">{check.error.message}</p>}

      <SaveButton dirty={dirty && shapeOk} saving={save.isPending} onClick={onSave} />
      {save.isError && <div className="text-[11px] text-red-500">{save.error?.message ?? 'Couldn’t save this setting.'}</div>}
    </SectionShell>
  );
}
