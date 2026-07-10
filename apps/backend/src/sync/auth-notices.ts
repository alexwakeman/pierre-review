import type { AuthNotice } from '@pierre-review/shared';

// Process-local record of orgs whose sync is currently BLOCKED by SAML SSO for an account — the
// sign-in token authenticates but isn't SSO-authorized for that org (see docs/GITHUB-AUTH-SETUP.md
// "the SAML wall"). Populated by the sync (recordSamlBlock when a repo's fetch is SAML-forbidden,
// cleared when any repo of that org next syncs cleanly), read by /api/me to drive the global
// "Reconnect GitHub" banner.
//
// Deliberately IN-MEMORY, not persisted: it's a rare, self-healing state. After a restart it
// simply repopulates on the next sync tick, and it clears itself once the user re-authorizes and
// the org reads cleanly again — so a DB column + dual-dialect migration would be overkill. (Cloud
// runs a single Fastify process, so the sync that writes this and the /api/me that reads it share
// the same map.) Local mode never watches SAML orgs / never populates this.

const blockedOrgsByAccount = new Map<number, Set<string>>();

// Mark `org` (a repo owner login) as SAML-blocked for this account.
export function recordSamlBlock(accountId: number, org: string): void {
  let set = blockedOrgsByAccount.get(accountId);
  if (!set) {
    set = new Set<string>();
    blockedOrgsByAccount.set(accountId, set);
  }
  set.add(org);
}

// Clear `org` for this account — called when any of its repos syncs cleanly (a SAML block is
// org-wide, so one clean read proves the token is authorized for the whole org again).
export function clearSamlBlock(accountId: number, org: string): void {
  const set = blockedOrgsByAccount.get(accountId);
  if (!set) return;
  if (set.delete(org) && set.size === 0) blockedOrgsByAccount.delete(accountId);
}

// The account's current auth notices (one per blocked org), for /api/me.
export function getAuthNotices(accountId: number): AuthNotice[] {
  const set = blockedOrgsByAccount.get(accountId);
  return set ? [...set].map((org) => ({ kind: 'saml_sso' as const, org })) : [];
}
