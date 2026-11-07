// SANDBOX WORKSPACE SETTINGS — the ONE reader/writer of `sandbox_workspace_settings` (migration 0174;
// docs/SANDBOX.md § The workspace mirror). Per WORKSPACE, nothing inherited; no row = every default.
// PUT semantics: the whole setting is REPLACED, a field left out goes back to its default.
import { and, asc, eq } from 'drizzle-orm';
import {
  SANDBOX_MEMORY_PROJECTS_MAX,
  SANDBOX_SERVICE_FILE_MAX,
  SANDBOX_SERVICE_STACKS_MAX,
  type SandboxServiceStackChoice,
  SANDBOX_PATH_MAX,
  SANDBOX_RESOURCE_LIMITS,
  type SandboxResourceChoice,
  type SandboxWorkspaceSettings,
  type SandboxWorkspaceSettingsBody,
} from '@pierre-review/shared';
import { isAbsolute, normalize } from 'node:path';
import { db, schema } from './client.js';
import { listSandboxAllowedHosts } from './sandbox-allowed-hosts.js';

const { sandboxWorkspaceSettings: t, workspaces, workspaceRepos, repos } = schema;

/** The stored setting without the hosts list (what a session reads). */
export type SandboxSettingsRow = Omit<SandboxWorkspaceSettings, 'alwaysAllowedHosts'>;

export function defaultSandboxSettings(workspaceId: number): SandboxSettingsRow {
  return {
    workspaceId,
    localFolder: null,
    memoryProjects: null,
    userClaudeMd: true,
    userSkills: false,
    startDir: null,
    globalProxyEnv: false,
    resources: { cpus: null, memoryGb: null, diskGb: null },
    services: [],
  };
}

async function ownsWorkspace(accountId: number, workspaceId: number): Promise<boolean> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .execute();
  return rows.length > 0;
}

function parseServices(json: string | null): SandboxServiceStackChoice[] {
  if (json == null) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => x != null && typeof x === 'object')
      .filter((x) => typeof x.repo === 'string' && typeof x.file === 'string')
      .map((x) => ({ repo: x.repo as string, file: x.file as string, egress: Array.isArray(x.egress) ? x.egress.filter((e): e is string => typeof e === 'string') : [] }));
  } catch {
    return [];
  }
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** A compose file path inside its repository: relative, no `..`, `.yml` / `.yaml`. */
export function validServiceFile(file: string): boolean {
  if (!file || file.length > SANDBOX_SERVICE_FILE_MAX || file.startsWith('/') || /[\0\n\\]/.test(file)) return false;
  const n = normalize(file);
  return !n.split('/').includes('..') && /\.ya?ml$/i.test(n);
}

function parseProjects(json: string | null): string[] | null {
  if (json == null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** null ⇒ not this account's workspace. */
export async function readSandboxSettings(accountId: number, workspaceId: number): Promise<SandboxSettingsRow | null> {
  if (!(await ownsWorkspace(accountId, workspaceId))) return null;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute();
  const r = rows[0];
  if (!r) return defaultSandboxSettings(workspaceId);
  return {
    workspaceId,
    localFolder: r.localFolder,
    memoryProjects: parseProjects(r.memoryProjectsJson),
    userClaudeMd: r.userClaudeMd,
    userSkills: r.userSkills,
    startDir: r.startDir,
    globalProxyEnv: r.globalProxyEnv,
    resources: { cpus: r.cpus, memoryGb: r.memoryGb, diskGb: r.diskGb },
    services: parseServices(r.servicesJson),
  };
}

/** The setting as the wire carries it (with the "Always allow" hosts). null ⇒ not owned. */
export async function getSandboxSettings(accountId: number, workspaceId: number): Promise<SandboxWorkspaceSettings | null> {
  const row = await readSandboxSettings(accountId, workspaceId);
  if (row == null) return null;
  return { ...row, alwaysAllowedHosts: await listSandboxAllowedHosts(accountId, workspaceId) };
}

const pathOk = (p: string): boolean => p.length <= SANDBOX_PATH_MAX && isAbsolute(p) && !/[\0\n,]/.test(p);

/** The meaning check, one plain sentence; null = fine. The shape is the route's ajv schema. */
export function validateSandboxSettings(body: SandboxWorkspaceSettingsBody): string | null {
  if (body.localFolder != null && !pathOk(body.localFolder)) return 'The local folder must be an absolute path without commas.';
  if (body.startDir != null && !pathOk(body.startDir)) return 'The starting folder must be an absolute path without commas.';
  if (body.memoryProjects != null) {
    if (body.memoryProjects.length > SANDBOX_MEMORY_PROJECTS_MAX) return `Choose at most ${SANDBOX_MEMORY_PROJECTS_MAX} memory projects.`;
    if (body.memoryProjects.some((p) => !pathOk(p))) return 'Each memory project must be an absolute path.';
  }
  if (body.services != null) {
    if (body.services.length > SANDBOX_SERVICE_STACKS_MAX) return `Choose at most ${SANDBOX_SERVICE_STACKS_MAX} compose files.`;
    for (const c of body.services) {
      if (!REPO_NAME.test(c.repo)) return 'Each compose file must name its repository as owner/name.';
      if (!validServiceFile(c.file)) return `${c.file} is not a compose file path inside the repository (a .yml or .yaml file).`;
      if (c.egress.some((e) => !SERVICE_NAME.test(e))) return 'Internet access must name services of the compose file.';
    }
    const keys = body.services.map((c) => `${c.repo.toLowerCase()}/${normalize(c.file)}`);
    if (new Set(keys).size !== keys.length) return 'Each compose file can be picked once.';
  }
  const res = body.resources ?? {};
  const words: Record<keyof SandboxResourceChoice, string> = { cpus: 'CPUs', memoryGb: 'Memory (GB)', diskGb: 'Disk (GB)' };
  for (const k of ['cpus', 'memoryGb', 'diskGb'] as const) {
    const v = res[k];
    if (v == null) continue;
    const { min, max } = SANDBOX_RESOURCE_LIMITS[k];
    if (!Number.isInteger(v) || v < min || v > max) return `${words[k]} must be a whole number from ${min} to ${max}.`;
  }
  return null;
}

const clean = (p: string | null | undefined): string | null => {
  if (p == null) return null;
  const s = p.trim();
  return s === '' ? null : normalize(s).replace(/(.)\/+$/, '$1');
};

/** REPLACE the setting. false ⇒ not this account's workspace. Call `validateSandboxSettings` first. */
export async function writeSandboxSettings(accountId: number, workspaceId: number, body: SandboxWorkspaceSettingsBody): Promise<boolean> {
  if (!(await ownsWorkspace(accountId, workspaceId))) return false;
  const projects = body.memoryProjects == null ? null : JSON.stringify([...new Set(body.memoryProjects.map((p) => clean(p)!))].sort());
  const values = {
    localFolder: clean(body.localFolder),
    memoryProjectsJson: projects,
    userClaudeMd: body.userClaudeMd ?? true,
    userSkills: body.userSkills ?? false,
    startDir: clean(body.startDir),
    globalProxyEnv: body.globalProxyEnv ?? false,
    cpus: body.resources?.cpus ?? null,
    memoryGb: body.resources?.memoryGb ?? null,
    diskGb: body.resources?.diskGb ?? null,
    servicesJson:
      body.services == null || body.services.length === 0
        ? null
        : JSON.stringify(body.services.map((c) => ({ repo: c.repo, file: normalize(c.file), egress: [...new Set(c.egress)].sort() }))),
    updatedAt: new Date(),
  };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: { ...values } })
    .execute();
  return true;
}

/** The workspace's member repositories, owner/name order. null ⇒ not this account's workspace. */
export async function sandboxWorkspaceRepos(
  accountId: number,
  workspaceId: number,
): Promise<Array<{ repoId: number; owner: string; name: string }> | null> {
  if (!(await ownsWorkspace(accountId, workspaceId))) return null;
  return db
    .select({ repoId: repos.id, owner: repos.owner, name: repos.name })
    .from(workspaceRepos)
    .innerJoin(repos, and(eq(repos.id, workspaceRepos.repoId), eq(repos.accountId, workspaceRepos.accountId)))
    .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.workspaceId, workspaceId)))
    .orderBy(asc(repos.owner), asc(repos.name))
    .execute();
}
