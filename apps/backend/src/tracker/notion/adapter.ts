import { notionBrowseUrl, notionDatabaseRoot } from '@pierre-review/shared';
import type { TrackerAdapter } from '../types.js';
import { detectPrefixKeys, isPrefixKey, normalizePrefixKey } from '../detect.js';
import { notionErrorMessage } from './client.js';
import { fetchNotionTicket } from './reader.js';

// NOTION — the fourth reading adapter (docs/TRACKERS.md § Notion). READ-ONLY.
//
//   IDENTITY    the root is the DATABASE: `https://www.notion.so/<32-hex id>` (shared
//               `notionDatabaseRoot`, the ONE fold), from the database URL saved in Settings. The key
//               is the page's prefixed Unique ID, upper-cased: `ENG-123`. Ident
//               `notion:https://www.notion.so/<id>#ENG-123`.
//   LINKING     the prefix-key rule. ⚠ The allowlist IS the Unique ID prefix: saving a mapping stores
//               it as the project keys (tracker/settings.ts), so detection is exact and may read the
//               branch; with no mapping saved nothing is detected.
//   LINK        `https://www.notion.so/ENG-123` — Notion opens a page by its prefixed Unique ID.
//               A read row keeps the page's own URL.
//   FETCH       ./reader.ts — a database query on the Unique ID number, the page's properties per the
//               mapping, its blocks as markdown and its comments, through ./client.ts.
//   CREDENTIAL  'token' — an internal integration token, sealed and write-only.
export const notionAdapter: TrackerAdapter = {
  provider: 'notion',
  label: 'Notion',
  siteRoot: (baseUrl) => notionDatabaseRoot(baseUrl),
  isKey: isPrefixKey,
  normalizeKey: normalizePrefixKey,
  browseUrl: (_baseUrl, key) => notionBrowseUrl(key),
  detect: (cfg, pr) => (cfg.projectKeys.length === 0 ? [] : detectPrefixKeys(cfg, pr)),
  reader: {
    credential: 'token',
    fetchTicket: (call, key) => fetchNotionTicket(call, key),
    errorMessage: (err) => notionErrorMessage(err),
  },
};
