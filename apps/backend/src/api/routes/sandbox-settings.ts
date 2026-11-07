import type { FastifyInstance } from 'fastify';
import {
  SANDBOX_MEMORY_PROJECTS_MAX,
  SANDBOX_SERVICE_FILE_MAX,
  SANDBOX_SERVICE_STACKS_MAX,
  SANDBOX_PATH_MAX,
  SANDBOX_RESOURCE_LIMITS,
  type SandboxFolderCheck,
  type SandboxFolderCheckBody,
  type SandboxRuntimeStatus,
  type SandboxWorkspaceSettings,
  type SandboxWorkspaceSettingsBody,
} from '@pierre-review/shared';
import { getSandboxSettings, readSandboxSettings, sandboxWorkspaceRepos, validateSandboxSettings, writeSandboxSettings } from '../../db/sandbox-settings.js';
import { addSandboxAllowedHost, removeSandboxAllowedHost } from '../../db/sandbox-allowed-hosts.js';
import { defaultLayoutPlaces, resolveWorkspaceLayout, toFolderCheck } from '../../sandbox/workspace/check.js';
import { sandboxRuntime } from '../../sandbox/runtime/index.js';
import type { RuntimeDetection, RuntimeFlavour } from '../../sandbox/runtime/types.js';
import { accountIdOf } from '../plugins/auth.js';

// SETTINGS → WORKSPACE → SANDBOX (docs/SANDBOX.md § The workspace mirror; docs/API.md § Sandbox
// settings). Registered only while agentic AI is on (app.ts). Every route is id-addressed: another
// account's workspace → 404. All are DB + local disk: no model, no GitHub, no tracker — the
// workspace-CRUD `read` tier, decided in rate-limit.ts.
//
//   GET    …/sandbox                 the setting (+ the "Always allow" hosts)
//   PUT    …/sandbox                 REPLACES it (a field left out goes back to its default)
//   POST   …/sandbox/check           walks the folder (bounded) and reports the match + memories
//   POST   …/sandbox/allowed-hosts   adds one "Always allow" host · DELETE removes one
//   GET    /api/sandbox/runtime       the container runtime on THIS computer (not workspace-scoped): the
//                                     build tab's start state and Settings' status line. Local process
//                                     checks only (`docker version` / `info`), cached RUNTIME_STATUS_TTL_MS.

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } as const;
const path = { type: ['string', 'null'], maxLength: SANDBOX_PATH_MAX } as const;
const resourceProp = (k: keyof typeof SANDBOX_RESOURCE_LIMITS) =>
  ({ type: ['integer', 'null'], minimum: SANDBOX_RESOURCE_LIMITS[k].min, maximum: SANDBOX_RESOURCE_LIMITS[k].max }) as const;

const settingsBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    localFolder: path,
    memoryProjects: { type: ['array', 'null'], maxItems: SANDBOX_MEMORY_PROJECTS_MAX, items: { type: 'string', maxLength: SANDBOX_PATH_MAX } },
    userClaudeMd: { type: 'boolean' },
    userSkills: { type: 'boolean' },
    startDir: path,
    globalProxyEnv: { type: 'boolean' },
    resources: {
      type: 'object',
      additionalProperties: false,
      properties: { cpus: resourceProp('cpus'), memoryGb: resourceProp('memoryGb'), diskGb: resourceProp('diskGb') },
    },
    services: {
      type: 'array',
      maxItems: SANDBOX_SERVICE_STACKS_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'file', 'egress'],
        properties: {
          repo: { type: 'string', minLength: 3, maxLength: 200 },
          file: { type: 'string', minLength: 1, maxLength: SANDBOX_SERVICE_FILE_MAX },
          egress: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 63 } },
        },
      },
    },
  },
} as const;

const ruleBody = { type: 'object', required: ['rule'], additionalProperties: false, properties: { rule: { type: 'string', minLength: 1, maxLength: 300 } } } as const;

const notFound = (id: number) => ({ error: 'NotFound', message: `Workspace ${id} not found` });

const FLAVOUR_NAME: Readonly<Record<RuntimeFlavour, string | null>> = {
  'docker-desktop': 'Docker Desktop',
  colima: 'Colima',
  podman: 'Podman',
  'rancher-desktop': 'Rancher Desktop',
  orbstack: 'OrbStack',
  'docker-engine': 'Docker Engine',
  microsandbox: 'microsandbox',
  fake: 'Test runtime',
  unknown: null,
};

/** The detection, in the reader's words. Pure. */
export function runtimeStatusOf(d: RuntimeDetection): SandboxRuntimeStatus {
  const found = d.cli != null;
  const name = FLAVOUR_NAME[d.flavour] ?? (d.kind === 'docker' && found ? 'Docker' : null);
  const version = d.serverVersion ?? d.cliVersion;
  return {
    available: d.available,
    kind: !found ? null : d.kind === 'microsandbox' ? 'microsandbox' : 'docker',
    label: name == null ? null : version != null ? `${name} ${version}` : name,
    licenceNote: d.licenceNote,
    problem: d.available ? null : (d.problem ?? 'No container runtime is running on this computer.'),
    cpus: d.cpus,
    memoryGb: d.memoryBytes == null ? null : Math.round((d.memoryBytes / 1024 ** 3) * 10) / 10,
  };
}

/** How long one detection answers the route (each one runs two or three CLI processes). */
export const RUNTIME_STATUS_TTL_MS = 10_000;
let runtimeCache: { at: number; status: Promise<SandboxRuntimeStatus> } | null = null;

/** Test seam: forget the cached detection. */
export function resetRuntimeStatusCacheForTests(): void {
  runtimeCache = null;
}

function currentRuntimeStatus(now = Date.now()): Promise<SandboxRuntimeStatus> {
  if (runtimeCache && now - runtimeCache.at < RUNTIME_STATUS_TTL_MS) return runtimeCache.status;
  const status = sandboxRuntime()
    .detect()
    .then(runtimeStatusOf)
    .catch(
      (): SandboxRuntimeStatus => ({
        available: false,
        kind: null,
        label: null,
        licenceNote: null,
        problem: 'Limn could not check the container runtime.',
        cpus: null,
        memoryGb: null,
      }),
    );
  runtimeCache = { at: now, status };
  return status;
}

export async function sandboxSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sandbox/runtime', async () => (await currentRuntimeStatus()) satisfies SandboxRuntimeStatus);

  app.get('/api/workspaces/:id/sandbox', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const s = await getSandboxSettings(accountIdOf(req), id);
    if (s == null) return reply.status(404).send(notFound(id));
    return s satisfies SandboxWorkspaceSettings;
  });

  app.put('/api/workspaces/:id/sandbox', { schema: { params: idParam, body: settingsBody } }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const body = (req.body ?? {}) as SandboxWorkspaceSettingsBody;
    const problem = validateSandboxSettings(body);
    if (problem) return reply.status(400).send({ error: 'InvalidSandboxSettings', message: problem });
    if (!(await writeSandboxSettings(accountId, id, body))) return reply.status(404).send(notFound(id));
    return (await getSandboxSettings(accountId, id))!;
  });

  app.post(
    '/api/workspaces/:id/sandbox/check',
    { schema: { params: idParam, body: { type: 'object', additionalProperties: false, properties: { folder: path } } } },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { id } = req.params as { id: number };
      const body = (req.body ?? {}) as SandboxFolderCheckBody;
      const [settings, repos] = await Promise.all([readSandboxSettings(accountId, id), sandboxWorkspaceRepos(accountId, id)]);
      if (settings == null || repos == null) return reply.status(404).send(notFound(id));
      const folder = body.folder === undefined ? settings.localFolder : body.folder;
      const places = defaultLayoutPlaces();
      // A folder other than the saved one starts with nothing ticked by choice: the default applies.
      const sameFolder = folder === settings.localFolder;
      const resolved = resolveWorkspaceLayout(
        repos,
        {
          localFolder: folder,
          memoryProjects: sameFolder ? settings.memoryProjects : null,
          startDir: sameFolder ? settings.startDir : null,
        },
        places,
      );
      return toFolderCheck(id, resolved, places) satisfies SandboxFolderCheck;
    },
  );

  app.post('/api/workspaces/:id/sandbox/allowed-hosts', { schema: { params: idParam, body: ruleBody } }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const r = await addSandboxAllowedHost(accountId, id, (req.body as { rule: string }).rule);
    if (!r.ok) {
      if (r.reason === 'No such workspace.') return reply.status(404).send(notFound(id));
      return reply.status(400).send({ error: 'InvalidHost', message: r.reason });
    }
    return (await getSandboxSettings(accountId, id))!;
  });

  app.delete('/api/workspaces/:id/sandbox/allowed-hosts', { schema: { params: idParam, body: ruleBody } }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const s = await getSandboxSettings(accountId, id);
    if (s == null) return reply.status(404).send(notFound(id));
    await removeSandboxAllowedHost(accountId, id, (req.body as { rule: string }).rule);
    return (await getSandboxSettings(accountId, id))!;
  });
}
