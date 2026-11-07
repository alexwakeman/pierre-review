// LIMN'S LABELS on every sandbox resource (docs/SANDBOX.md § Labels and the sweep). A container,
// network or volume without them is invisible to `destroy` / `sweep`, so every create goes through
// `resourceLabels` and no caller spells a label by hand.
//
//   limn.managed=<instance>  the sweep's filter: a short hash of the Limn DATA DIR (`appInstance`), so
//                            two Limn installs on one machine (`pnpm demo` beside the real one) never
//                            sweep each other's sessions. A test passes its own value, so a running
//                            app's boot sweep never removes a test's resources, nor a test's the app's.
//   limn.session=<id>        the session the resource belongs to.
//   limn.account=<id>        the account (the one local account today; kept for the isolation rule).
//   limn.role=<role>         what it is: sandbox, proxy, service, setup, network, volume, image.
//
// ⚠ THE REPO STORE carries `limn.store=<instance>` and `limn.role=store` and NO `limn.managed`: the
// sweep lists by `limn.managed`, so it cannot see the store at all (structural, not a filter).
// `limn sandbox prune --store` removes it by its own label.

import { createHash } from 'node:crypto';
import { resolveDataDir } from '../../data-dir.js';

export const LABEL_MANAGED = 'limn.managed';
export const LABEL_SESSION = 'limn.session';
export const LABEL_ACCOUNT = 'limn.account';
export const LABEL_ROLE = 'limn.role';
export const LABEL_STORE = 'limn.store';

/** Where the repo store sits: read-write in a maintenance container, read-only in a sandbox. */
export const STORE_MOUNT = '/limn-store';

/** The `limn.managed` value for the Limn whose data dir this is. */
export function appInstance(env: NodeJS.ProcessEnv = process.env): string {
  return `d${createHash('sha256').update(resolveDataDir(env)).digest('hex').slice(0, 12)}`;
}

export type ResourceRole = 'sandbox' | 'proxy' | 'service' | 'setup' | 'network' | 'volume' | 'image' | 'store';

/** The repo store's volume name for one Limn install (a test passes its own instance). */
export function repoStoreName(instance: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(instance)) throw new Error(`Not a valid instance: ${JSON.stringify(instance)}`);
  return `limn-repo-store-${instance}`;
}

/** The store volume's labels: never `limn.managed` (see the header). */
export function storeLabels(instance: string, extra: Record<string, string> = {}): Record<string, string> {
  const { [LABEL_MANAGED]: _drop, ...rest } = extra;
  return { ...rest, [LABEL_STORE]: instance, [LABEL_ROLE]: 'store' };
}

/** A session id as it may appear in a resource name: lower-case letters, digits, `-` and `_`. */
const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function assertSessionId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not a valid sandbox session id: ${JSON.stringify(sessionId)}`);
  return sessionId;
}

/** `limn-<session>-<suffix>`: the name of a session's container, network or volume. */
export function resourceName(sessionId: string, suffix: string): string {
  assertSessionId(sessionId);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(suffix)) throw new Error(`Not a valid resource suffix: ${JSON.stringify(suffix)}`);
  return `limn-${sessionId}-${suffix}`;
}

export function resourceLabels(
  instance: string,
  owner: { sessionId: string; accountId: number },
  role: ResourceRole,
  extra: Record<string, string> = {},
): Record<string, string> {
  assertSessionId(owner.sessionId);
  return {
    ...extra,
    [LABEL_MANAGED]: instance,
    [LABEL_SESSION]: owner.sessionId,
    [LABEL_ACCOUNT]: String(owner.accountId),
    [LABEL_ROLE]: role,
  };
}

/** `--label k=v` pairs for a CLI argv. */
export function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
}
