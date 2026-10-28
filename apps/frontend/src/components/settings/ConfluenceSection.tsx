import { useEffect, useId, useState } from 'react';
import type { WikiCredentialsSettings, WikiCredentialsUpdate } from '@pierre-review/shared';
import { useCheckWikiCredentials, useSetWikiCredentials, useWikiCredentials } from '../../hooks/useReferenceDocs.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const SECONDARY_BTN =
  'rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/**
 * "Confluence" for THIS workspace's reference docs (CORE, local only — mounted beside Reference docs on
 * `me.ai.enabled`; docs/REFERENCE-DOCS.md § Wiki sources → Credentials). The site, the Atlassian
 * email and a WRITE-ONLY API token. A page on the workspace's Jira site uses the Jira token instead,
 * and the section says so.
 *
 * ⚠ DRAFT + SAVE like every section here. ⚠ THE TOKEN IS NEVER SHOWN (`hasToken` only). ⚠ "Test
 * connection" is CLICK-GATED (one Confluence read with the SAVED credential).
 */
export function ConfluenceSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useWikiCredentials(workspaceId);
  if (workspaceId == null || q.data == null || q.data.workspaceId !== workspaceId) {
    return <ScopePendingSection title="Confluence" failed={q.isError} />;
  }
  return <ConfluenceForm key={workspaceId} workspaceId={workspaceId} saved={q.data} />;
}

function ConfluenceForm({ workspaceId, saved }: { workspaceId: number; saved: WikiCredentialsSettings }): JSX.Element {
  const save = useSetWikiCredentials(workspaceId);
  const check = useCheckWikiCredentials(workspaceId);
  const ids = { site: useId(), email: useId(), token: useId() };
  const c = saved.confluence;

  const [site, setSite] = useState(c.siteUrl ?? '');
  const [email, setEmail] = useState(c.email ?? '');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const signature = `${c.siteUrl ?? ''}|${c.email ?? ''}|${c.hasToken}`;
  useEffect(() => {
    setSite(c.siteUrl ?? '');
    setEmail(c.email ?? '');
    setToken('');
    setReplacing(false);
    setRemoving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const siteChanged = site.trim() !== (c.siteUrl ?? '');
  const emailChanged = email.trim() !== (c.email ?? '');
  const typedToken = token.trim();
  const dirty = siteChanged || emailChanged || typedToken !== '' || removing;
  const showTokenInput = (!c.hasToken || replacing) && !removing;
  const canTest = !dirty && ((c.hasToken && c.siteUrl != null) || c.jiraSite != null);

  const onSave = (): void => {
    const patch: WikiCredentialsUpdate['confluence'] = {};
    if (siteChanged) patch.siteUrl = site.trim() === '' ? null : site.trim();
    if (emailChanged) patch.email = email.trim() === '' ? null : email.trim();
    if (removing) patch.token = null;
    else if (typedToken !== '') patch.token = typedToken;
    save.mutate({ confluence: patch });
  };

  return (
    <SectionShell
      title="Confluence"
      desc={c.jiraSite ? `Pages on ${c.jiraSite} use your Jira token.` : 'Add Confluence pages to Docs.'}
      info={
        <InfoButton title="Confluence">
          <div className="space-y-2">
            <p>
              Create an API token at id.atlassian.com under Security → API tokens, and use the email of that Atlassian
              account. Limn only reads pages.
            </p>
            <p>When Jira is this workspace&rsquo;s tracker, a page on the same site uses the Jira email and token.</p>
            <p>The token is stored sealed and is never shown again.</p>
          </div>
        </InfoButton>
      }
    >
      <Field label="Site" htmlFor={ids.site}>
        <input
          id={ids.site}
          className={inputCls}
          autoComplete="off"
          placeholder="https://acme.atlassian.net"
          value={site}
          onChange={(e) => setSite(e.target.value)}
        />
      </Field>
      <Field label="Email" htmlFor={ids.email}>
        <input id={ids.email} className={inputCls} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {showTokenInput ? (
        <Field label="API token" htmlFor={ids.token} hint={c.hasToken ? 'Replaces the saved token when you save.' : undefined}>
          <input
            id={ids.token}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-gray-600 dark:text-gray-300">API token</span>
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

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BTN} disabled={!canTest || check.isPending} onClick={() => check.mutate()}>
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

      <SaveButton dirty={dirty} saving={save.isPending} onClick={onSave} />
      {save.isError && <div className="text-[11px] text-red-500">{save.error?.message ?? 'Couldn’t save this setting.'}</div>}
    </SectionShell>
  );
}
