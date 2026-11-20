import { useEffect, useId, useState } from 'react';
import type { WikiCredentialsSettings, WikiCredentialsUpdate } from '@pierre-review/shared';
import { useCheckWikiCredentials, useSetWikiCredentials, useWikiCredentials } from '../../hooks/useReferenceDocs.js';
import { InfoButton } from '../InfoModal.js';
import { CheckCircleIcon } from '../Icons.js';
import { Field, SectionShell, inputCls } from './ui.js';
import { SaveState, useAutoSave } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const SECONDARY_BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:cursor-not-allowed disabled:opacity-40';

/**
 * "Confluence" for THIS workspace's reference docs (CORE, local only — Settings → Docs on
 * `me.ai.enabled`, and inside the add-documents wizard; docs/REFERENCE-DOCS.md § Wiki sources →
 * Credentials). The site, the Atlassian email and a WRITE-ONLY API token.
 *
 * ⚠ JIRA FIRST: when Jira is the workspace's tracker (with an email and a token) and no Confluence token
 * of its own is saved, the section reads READY — "Using your Jira connection" — and asks for nothing
 * (Atlassian Cloud shares one site and one API token). "Use a different token" opens the fields to
 * override it; the server's ladder prefers the workspace's own token on the same host.
 *
 * No Save button (./autosave.tsx): site and email save as you type (debounced, at once on blur /
 * Enter); the token is written ONLY on blur or Enter of a non-empty value; Remove writes at once.
 * ⚠ THE TOKEN IS NEVER SHOWN (`hasToken` only). ⚠ "Test connection" is CLICK-GATED (one Confluence
 * read with the SAVED credential).
 */
export function ConfluenceSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const q = useWikiCredentials(workspaceId);
  if (workspaceId == null || q.data == null || q.data.workspaceId !== workspaceId) {
    return <ScopePendingSection title="Confluence" failed={q.isError} />;
  }
  return <ConfluenceForm key={workspaceId} workspaceId={workspaceId} saved={q.data} />;
}

export function ConfluenceForm({ workspaceId, saved }: { workspaceId: number; saved: WikiCredentialsSettings }): JSX.Element {
  const save = useSetWikiCredentials(workspaceId);
  // The token's own write (commit on blur / Enter, Remove), apart from the fields' autosave.
  const tokenSave = useSetWikiCredentials(workspaceId);
  const check = useCheckWikiCredentials(workspaceId);
  const ids = { site: useId(), email: useId(), token: useId() };
  const c = saved.confluence;

  const [site, setSite] = useState(c.siteUrl ?? '');
  const [email, setEmail] = useState(c.email ?? '');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  // Jira's connection covers Confluence until the reader chooses to override it.
  const viaJira = c.jiraSite != null && !c.hasToken && c.siteUrl == null;
  const [overriding, setOverriding] = useState(false);

  // Each field re-seeds on its OWN stored value, so a write of one never wipes a half-typed other.
  useEffect(() => setSite(c.siteUrl ?? ''), [c.siteUrl]);
  useEffect(() => setEmail(c.email ?? ''), [c.email]);
  useEffect(() => {
    setToken('');
    setReplacing(false);
  }, [c.hasToken]);

  const siteChanged = site.trim() !== (c.siteUrl ?? '');
  const emailChanged = email.trim() !== (c.email ?? '');
  const typedToken = token.trim();
  const dirty = siteChanged || emailChanged;
  const showTokenInput = !c.hasToken || replacing;
  const canTest = !dirty && ((c.hasToken && c.siteUrl != null) || c.jiraSite != null);

  const autosave = useAutoSave({
    key: `${site.trim()}|${email.trim()}`,
    ready: dirty,
    busy: save.isPending,
    run: () => {
      const patch: WikiCredentialsUpdate['confluence'] = {};
      if (siteChanged) patch.siteUrl = site.trim() === '' ? null : site.trim();
      if (emailChanged) patch.email = email.trim() === '' ? null : email.trim();
      save.mutate({ confluence: patch });
    },
  });
  const flushOnEnter = (e: { key: string }): void => {
    if (e.key === 'Enter') autosave.flush();
  };
  // A committed secret leaves the field at once and is never echoed (Replace closes too).
  const clearToken = (): void => {
    setToken('');
    setReplacing(false);
  };
  const commitToken = (): void => {
    if (typedToken === '' || tokenSave.isPending) return;
    tokenSave.mutate({ confluence: { token: typedToken } }, { onSuccess: clearToken });
  };

  const info = (
    <InfoButton title="Confluence">
      <div className="space-y-2">
        <p>
          Create an API token at id.atlassian.com under Security → API tokens, and use the email of that Atlassian
          account. Ensemble only reads pages.
        </p>
        <p>When Jira is this workspace&rsquo;s tracker, a page on the same site uses the Jira email and token.</p>
        <p>The token is stored sealed and is never shown again.</p>
      </div>
    </InfoButton>
  );

  if (viaJira && !overriding) {
    return (
      <SectionShell title="Confluence" desc="Ready." info={info}>
        <p className="flex items-center gap-1.5 text-body text-ui-ink" data-testid="confluence-via-jira">
          <CheckCircleIcon size={14} className="shrink-0 text-ui-success" aria-hidden />
          Using your Jira connection ({c.jiraSite}).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={SECONDARY_BTN} disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" className={SECONDARY_BTN} onClick={() => setOverriding(true)}>
            Use a different token
          </button>
          {check.data != null && (
            <span className={`text-meta ${check.data.ok ? 'text-ui-success' : 'text-ui-danger'}`}>{check.data.message}</span>
          )}
        </div>
        {check.isError && <p className="text-body text-ui-danger">{check.error.message}</p>}
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Confluence"
      desc={c.jiraSite && !overriding ? `Pages on ${c.jiraSite} use your Jira token.` : 'Add Confluence pages to Docs.'}
      info={info}
    >
      <Field label="Site" htmlFor={ids.site}>
        <input
          id={ids.site}
          className={inputCls}
          autoComplete="off"
          placeholder="https://acme.atlassian.net"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          onBlur={autosave.flush}
          onKeyDown={flushOnEnter}
        />
      </Field>
      <Field label="Email" htmlFor={ids.email}>
        <input
          id={ids.email}
          className={inputCls}
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={autosave.flush}
          onKeyDown={flushOnEnter}
        />
      </Field>
      <SaveState section="Confluence" mutation={save} dirty={dirty} />
      {showTokenInput ? (
        <Field
          label="API token"
          htmlFor={ids.token}
          hint={c.hasToken ? 'Saved when you press Enter or leave the field. It replaces the saved one.' : 'Saved when you press Enter or leave the field.'}
        >
          <input
            id={ids.token}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={commitToken}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitToken();
              }
            }}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1 text-body">
          <span className="font-medium text-ui-mute">API token</span>
          <div className="flex items-center gap-2">
            <span className="text-ui-ink">Saved</span>
            <button type="button" className={SECONDARY_BTN} onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button
              type="button"
              className={SECONDARY_BTN}
              disabled={tokenSave.isPending}
              onClick={() => tokenSave.mutate({ confluence: { token: null } })}
            >
              Remove
            </button>
          </div>
        </div>
      )}
      <SaveState section="Confluence API token" mutation={tokenSave} dirty={false} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BTN} disabled={!canTest || check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? 'Testing…' : 'Test connection'}
        </button>
        {check.data != null && (
          <span className={`text-meta ${check.data.ok ? 'text-ui-success' : 'text-ui-danger'}`}>
            {check.data.message}
          </span>
        )}
      </div>
      {check.isError && <p className="text-body text-ui-danger">{check.error.message}</p>}

      {overriding && !dirty && (
        <button type="button" className={`${SECONDARY_BTN} self-start`} onClick={() => setOverriding(false)}>
          Use Jira&rsquo;s connection
        </button>
      )}
    </SectionShell>
  );
}
