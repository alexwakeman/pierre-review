import { jiraApiRoot } from '@pierre-review/shared';
import type { TrackerAdapter } from '../types.js';
import { detectPrefixKeys, isPrefixKey, normalizePrefixKey } from '../detect.js';
import { fetchJiraIssue, jiraErrorMessage } from './client.js';

// JIRA — the first adapter, and the one with a reader. Identity is the shared `jiraApiRoot` fold
// (the ONE copy; the SPA folds a browse link onto the same root). Detection is the prefix-key rule
// with the workspace's allowlist and match scope. The reader is REST v2 `issue/<KEY>?fields=*all&
// expand=names,schema` through `jira/fetch.ts` — no redirects, a size cap, and in cloud the
// connect-time private-address refusal — and the credential is the workspace's sealed token.
export const jiraAdapter: TrackerAdapter = {
  provider: 'jira',
  label: 'Jira',
  siteRoot: (baseUrl) => jiraApiRoot(baseUrl),
  isKey: isPrefixKey,
  normalizeKey: normalizePrefixKey,
  browseUrl: (baseUrl, key) => `${baseUrl.replace(/\/+$/, '')}/browse/${key}`,
  detect: (cfg, pr) => detectPrefixKeys(cfg, pr),
  reader: {
    credential: 'token',
    fetchTicket: (call, key) => fetchJiraIssue(call, key),
    errorMessage: (err) => jiraErrorMessage(err),
  },
};
