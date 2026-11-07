// A SESSION'S SERVICES (docs/SANDBOX.md § Services). What the session manager (WP7) calls, after the
// workspace mirror (the compose files are read inside the sandbox, so the repositories must be there):
//
//   1. `serviceStacksFor(settings.services, layout.repos)` — the reader's picked files, placed;
//   2. `startSessionServices({...})` — the controller + the relay; `inventory()` names the services
//      for the seed (`SeedService[]`) before the seed is written;
//   3. on discard: `services.close()` (stops the files), then `runtime.destroy(sessionId)` removes
//      whatever is left, built images included.
//
// The Docker backend only. On microsandbox, `dind.ts` instead (code only, untested).
import { posix } from 'node:path';
import type { SandboxServicesStatus, SandboxServiceStackChoice } from '@pierre-review/shared';
import type { SandboxRuntime, SessionOwner } from '../runtime/types.js';
import { ServicesController, stackKeyFor, type ServiceStackConfig } from './controller.js';
import type { ServiceLimits } from './policy.js';
import { startServicesRelay } from './relay.js';

export { policeCompose, DEFAULT_SERVICE_LIMITS, DEFAULT_ALLOWED_REGISTRIES } from './policy.js';
export type { PolicyResult, PolicedStack, Forward, ServiceLimits } from './policy.js';
export { ServicesController, USAGE as LIMN_SVC_USAGE } from './controller.js';
export type { ServiceStackConfig } from './controller.js';
export { prepareDindServices, startDindDaemon } from './dind.js';

/** A picked file's path must stay inside its repository. */
export function validComposePath(file: string): boolean {
  if (!file || file.length > 300 || file.startsWith('/') || /[\0\n\\]/.test(file)) return false;
  const n = posix.normalize(file);
  return !n.startsWith('..') && !n.split('/').includes('..') && /\.ya?ml$/i.test(n);
}

/** The picked files, each at its repository's place in the sandbox. A file of a repository that is not
 *  in the session is left out with one line. */
export function serviceStacksFor(
  choices: readonly SandboxServiceStackChoice[],
  repos: readonly { fullName: string; path: string }[],
): { stacks: ServiceStackConfig[]; notes: string[] } {
  const stacks: ServiceStackConfig[] = [];
  const notes: string[] = [];
  const taken = new Set<string>();
  for (const c of choices) {
    const repo = repos.find((r) => r.fullName.toLowerCase() === c.repo.toLowerCase());
    if (!repo) {
      notes.push(`${c.repo}/${c.file} is not used: the repository is not in this session.`);
      continue;
    }
    if (!validComposePath(c.file)) {
      notes.push(`${c.repo}/${c.file} is not used: not a compose file path.`);
      continue;
    }
    const key = stackKeyFor(repo.fullName, taken);
    taken.add(key);
    stacks.push({ key, repoPath: repo.path, file: posix.normalize(c.file), from: `${repo.fullName.split('/').pop()}/${posix.normalize(c.file)}`, egress: [...c.egress] });
  }
  return { stacks, notes };
}

export interface SessionServices {
  controller: ServicesController;
  status(): SandboxServicesStatus;
  /** The services in each picked file, for the seed. */
  inventory(): Promise<{ name: string; from: string; stack: string }[]>;
  /** Stop every file and the relay. */
  close(): Promise<void>;
}

export async function startSessionServices(o: {
  runtime: SandboxRuntime;
  owner: SessionOwner;
  sandbox: string;
  network: string;
  workspaceRoot: string;
  workspaceVolume: string;
  stacks: readonly ServiceStackConfig[];
  serverVersion?: string | null;
  limits?: ServiceLimits;
  instance?: string;
  extraLabels?: Record<string, string>;
  onStatus?: (s: SandboxServicesStatus) => void;
  onOutput?: (line: string) => void;
  onProblem?: (line: string) => void;
}): Promise<SessionServices> {
  const controller = new ServicesController(o);
  const relay = startServicesRelay({ runtime: o.runtime, sandbox: o.sandbox, controller, ...(o.onProblem ? { onProblem: o.onProblem } : {}) });
  await relay.ready;
  return {
    controller,
    status: () => controller.status(),
    inventory: () => controller.inventory(),
    async close() {
      await controller.stopAll();
      relay.close();
    },
  };
}
