import { linearSiteRoot } from '@pierre-review/shared';
import type { DetectedTicket, TrackerAdapter } from '../types.js';
import { detectPrefixKeys, isPrefixKey, normalizePrefixKey } from '../detect.js';
import { fetchLinearIssue, linearErrorMessage } from './client.js';
import { LINEAR_LINK_CAP, linearLinker } from './links.js';

// LINEAR — the third reading adapter (docs/TRACKERS.md § Linear).
//
//   IDENTITY    the root is the Linear WORKSPACE: `https://linear.app/<urlKey>`, lower-cased (shared
//               `linearSiteRoot`, the ONE fold), from the workspace URL saved in Settings. The key is
//               the team key and number, upper-cased: `ENG-123`. Ident
//               `linear:https://linear.app/acme#ENG-123`.
//   LINKING     best first: the issues Linear's GitHub integration ATTACHED the PR to (./links.ts,
//               stored on the PR), THEN the keys detection finds in the title and branch with the
//               workspace's team-key allowlist and match scope — the union, links first.
//   FETCH       ./client.ts — one GraphQL call per issue to the fixed `api.linear.app`, with the
//               workspace's sealed personal API key.
//   CREDENTIAL  'token'.
export const linearAdapter: TrackerAdapter = {
  provider: 'linear',
  label: 'Linear',
  siteRoot: (baseUrl) => linearSiteRoot(baseUrl),
  isKey: isPrefixKey,
  normalizeKey: normalizePrefixKey,
  // Built on the canonical root, so `https://linear.app/Acme/` and `…/acme` link identically.
  browseUrl: (baseUrl, key) => `${linearSiteRoot(baseUrl) ?? baseUrl.replace(/\/+$/, '')}/issue/${key}`,
  detect: (cfg, pr) => {
    const root = linearSiteRoot(cfg.baseUrl);
    // Links read against ANOTHER Linear workspace (a new key, a moved URL) are not this one's.
    const linked = root != null && pr.linearLinksRoot === root ? (pr.linearLinks ?? []) : [];
    const out: DetectedTicket[] = [];
    for (const raw of linked) {
      const key = normalizePrefixKey(raw);
      if (key == null || out.some((d) => d.key === key)) continue;
      out.push({ key, from: 'link', order: out.length });
      if (out.length >= LINEAR_LINK_CAP) break;
    }
    for (const d of detectPrefixKeys(cfg, pr)) {
      if (out.some((o) => o.key === d.key)) continue;
      out.push({ ...d, order: out.length });
    }
    return out;
  },
  reader: {
    credential: 'token',
    fetchTicket: (call, key) => fetchLinearIssue(call, key),
    errorMessage: (err) => linearErrorMessage(err),
  },
  linker: linearLinker,
};
