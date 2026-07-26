import { useCallback, useState } from 'react';
import { useMe } from '../../hooks/useTriage.js';
import { analyticsConfigured, revokeAnalytics } from '../../lib/analytics.js';
import { consentChoice, resetConsent } from '../../lib/consent.js';
import { SectionShell, inputCls } from './ui.js';

// "Your data" — the self-service side of the data-subject rights promised at /privacy §9.
//
// These are the machinery behind the policy, not decoration. A privacy notice that says "email
// us to be deleted" is a promise backed by someone remembering to run SQL; export and delete
// buttons are a promise backed by code (GET /api/me/export, DELETE /api/me/account).
//
// CLOUD-ONLY, gated by the caller. A local install has no hosted account to erase — the data is
// a SQLite file the user already owns, and the server would just re-synthesize the account from
// `gh api user` on the next boot — so the backend refuses it there and this section is hidden
// rather than offering a button that 400s.

export function YourDataSection(): JSX.Element {
  const { data: me } = useMe();
  const login = me?.user?.login ?? '';

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Fetched with a raw fetch rather than the typed client: the response is a FILE download, so
  // it needs the blob + object-URL dance instead of JSON parsing.
  const download = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch('/api/me/export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pierre-export-${login || 'account'}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Release the blob; without this the whole export stays pinned in memory for the tab's life.
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }, [login]);

  const doDelete = useCallback(async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/me/account', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmLogin: typed.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Deletion failed (${res.status})`);
      }
      // The session is gone server-side; a hard reload lands on the sign-in gate rather than
      // leaving a dead SPA holding queries for an account that no longer exists.
      window.location.assign('/');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Deletion failed.');
      setDeleting(false);
    }
  }, [typed]);

  const confirmMatches = typed.trim().toLowerCase() === login.toLowerCase() && login !== '';
  const currentConsent = consentChoice();

  return (
    <SectionShell
      title="Your data"
      desc="Download everything we hold for your account, change your cookie choice, or delete the account entirely."
    >
      {/* ---- Export (Art. 15 access + Art. 20 portability) ---- */}
      <div>
        <button
          type="button"
          onClick={download}
          disabled={exporting}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
        >
          {exporting ? 'Preparing…' : 'Download my data (JSON)'}
        </button>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
          Your account, repositories, teams, synced pull-request activity and AI usage. Your stored
          GitHub token is deliberately excluded — it is a credential, and an export file is not a
          safe place for one.
        </p>
        {exportError != null && (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{exportError}</p>
        )}
      </div>

      {/* ---- Cookie choice (withdrawal must be as easy as consent) ---- */}
      {analyticsConfigured() && (
        <div className="border-t border-gray-100 pt-2.5 dark:border-gray-800">
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            Analytics cookies:{' '}
            <span className="font-medium text-gray-700 dark:text-gray-200">
              {currentConsent === 'granted'
                ? 'accepted'
                : currentConsent === 'denied'
                  ? 'declined'
                  : 'not chosen'}
            </span>
          </p>
          <button
            type="button"
            onClick={() => {
              revokeAnalytics();
              resetConsent();
            }}
            className="mt-1 rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
          >
            Change cookie choice
          </button>
        </div>
      )}

      {/* ---- Erasure (Art. 17) ---- */}
      <div className="border-t border-gray-100 pt-2.5 dark:border-gray-800">
        {!confirmOpen ? (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="rounded border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:border-red-400 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            Delete my account
          </button>
        ) : (
          <div className="rounded border border-red-300 bg-red-50 p-2.5 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs font-semibold text-red-700 dark:text-red-300">
              This cannot be undone.
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-red-700/90 dark:text-red-300/90">
              Deletes your account, your encrypted GitHub token, every repository you added and all
              activity synced for them. Nothing is archived. Your repositories on GitHub are, of
              course, untouched — this only removes Pierre&apos;s copy.
            </p>
            <label className="mt-2 block text-[11px] font-medium text-red-700 dark:text-red-300">
              Type <span className="font-mono">{login || 'your GitHub username'}</span> to confirm
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={`${inputCls} mt-1`}
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={doDelete}
                disabled={!confirmMatches || deleting}
                className="rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Permanently delete'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  setTyped('');
                  setDeleteError(null);
                }}
                disabled={deleting}
                className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
              >
                Cancel
              </button>
            </div>
            {deleteError != null && (
              <p className="mt-1.5 text-[11px] text-red-700 dark:text-red-300">{deleteError}</p>
            )}
          </div>
        )}
      </div>
    </SectionShell>
  );
}
