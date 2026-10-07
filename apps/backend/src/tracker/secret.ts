import type { TrackerContext } from './context.js';

// The per-workspace tracker token at rest (`workspace_trackers.auth_token`; it lived in the plugin's
// `pro_workspace_settings.jira_token` before apiVersion 23 and was MOVED, in its stored form, by
// ./legacy-import.ts — the prefixes below are why that needs no re-entry).
//
// A tracker token reads the team's WHOLE tracker, so it is sealed whenever the process can seal it:
// `ctx.host.sealSecret` is core's AES-256-GCM (`auth/crypto.ts`, wired in ./runtime.ts), present
// whenever ENCRYPTION_KEY is valid — always in cloud. A local install without a key stores it plain, which
// is the same trust as that machine's `gh` token (and the local SQLite file it sits in).
//
// ⚠ BOTH FORMS ARE PREFIXED so either stays readable after the host's capability changes: a local
// install that later sets ENCRYPTION_KEY still reads its `plain:` rows, and re-saving seals them.
// A `sealed:` row on a host that can no longer open it (key removed or rotated) reads as
// `unreadable` — the Settings screen still says a token is saved, and every Jira call answers
// "save the token again" rather than sending garbage as a credential.
//
// ⚠ NOTHING HERE LOGS, and no caller may log the value in either form.

export type HostSeal = Pick<TrackerContext['host'], 'sealSecret' | 'openSecret'>;

const SEALED = 'sealed:v1:';
const PLAIN = 'plain:';

export function storeTrackerToken(host: HostSeal | undefined, token: string): string {
  return host?.sealSecret ? `${SEALED}${host.sealSecret(token)}` : `${PLAIN}${token}`;
}

export type OpenedToken =
  | { state: 'none' }
  | { state: 'ok'; token: string }
  | { state: 'unreadable' };

export function openTrackerToken(
  host: HostSeal | undefined,
  stored: string | null | undefined,
): OpenedToken {
  if (stored == null || stored === '') return { state: 'none' };
  if (stored.startsWith(PLAIN)) {
    const token = stored.slice(PLAIN.length);
    return token === '' ? { state: 'none' } : { state: 'ok', token };
  }
  if (stored.startsWith(SEALED)) {
    if (!host?.openSecret) return { state: 'unreadable' };
    try {
      const token = host.openSecret(stored.slice(SEALED.length));
      return token === '' ? { state: 'unreadable' } : { state: 'ok', token };
    } catch {
      // Wrong key, tampered ciphertext. Never surface the error text (it can name the format).
      return { state: 'unreadable' };
    }
  }
  // An unprefixed value is not a format this code wrote, so it is never sent as a credential.
  return { state: 'unreadable' };
}
