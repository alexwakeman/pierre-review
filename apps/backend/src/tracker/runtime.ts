import { config } from '../config.js';
import { accountIdOf } from '../api/plugins/auth.js';
import { db, schema, isPg } from '../db/client.js';
import { decryptToken, encryptToken, sealingAvailable } from '../auth/crypto.js';
import type { TrackerContext, TrackerLog } from './context.js';

// The production TrackerContext — every member a DIRECT core import (the AgentContext precedent).
// One process-wide instance, built lazily on first use so importing a tracker module never opens
// the database: the PR-detail enricher, the ticket review's seam and the worker all read it.

const consoleLog: TrackerLog = {
  warn: (obj, msg) => console.warn(msg ?? 'tracker', obj),
  info: () => {},
  error: (obj, msg) => console.error(msg ?? 'tracker', obj),
};

export function buildTrackerContext(log: TrackerLog = consoleLog): TrackerContext {
  return {
    log,
    host: {
      isCloud: config.isCloud,
      // Sealing whenever a key exists (always in cloud). Same functions the plugin was handed.
      ...(sealingAvailable() ? { sealSecret: encryptToken, openSecret: decryptToken } : {}),
    },
    accountIdOf,
    db,
    schema: schema as unknown as Record<string, unknown> as TrackerContext['schema'],
    isPg,
    // Dynamic: db/queries.ts imports the PR-detail enricher, which imports this module.
    defaultWorkspaceId: async (accountId) => (await import('../db/queries.js')).ensureDefaultWorkspace(accountId),
    // GitHub Issues reads with the ACCOUNT's own token, resolved per call (local: `gh auth token`;
    // cloud: the sealed per-user token). ⚠ No token is held here between calls.
    github: {
      graphql: async (accountId, query, variables) => {
        const [{ getAccessToken }, { getGraphqlClientFor, graphqlTolerant }] = await Promise.all([
          import('../auth/account.js'),
          import('../github/client.js'),
        ]);
        const token = await getAccessToken(accountId);
        let errors: unknown;
        const data = await graphqlTolerant(getGraphqlClientFor(token), query, variables, (e) => {
          errors = e;
        });
        return { data: data as never, errors };
      },
    },
  };
}

let shared: TrackerContext | null = null;

/** The process's TrackerContext. `useLog` (once, at boot) swaps in the server's pino logger. */
export function trackerContext(useLog?: TrackerLog): TrackerContext {
  if (shared == null) shared = buildTrackerContext(useLog);
  else if (useLog != null) shared = { ...shared, log: useLog };
  return shared;
}
