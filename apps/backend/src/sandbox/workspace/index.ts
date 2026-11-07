// A WORKSPACE SESSION'S FILES (docs/SANDBOX.md § The workspace mirror). What the session manager (WP7)
// calls, in order:
//
//   1. `resolveWorkspaceLayout(repos, settings)`  (check.ts) — the SAME computation Settings shows;
//   2. `sandboxMountsFor(layout, volume)`          — the one session volume at the layout's root and the
//                                                    container's working folder;
//   3. `readSessionTicket(…)`                      (ticket.ts) — the ticket, read fresh;
//   4. `prepareSessionWorkspace(runtime, container, …)` — the git identity, the repositories, the reader's
//      files, then the seed (seed.ts). Returns the seed so the driver appends `systemPrompts[provider]`.
import { readSmallFile } from './memories.js';
import { mirrorRepos, prepareSandboxGit, readerFiles, type MirrorResult, type MirrorSeams, type RepoBaseRequest } from './mirror.js';
import { buildSeed, type Seed, type SeedRepoBase, type SeedService } from './seed.js';
import type { LayoutPlaces, ResolvedWorkspace } from './check.js';
import { folderClaudeMdPath } from './check.js';
import type { WorkspaceLayout } from './layout.js';
import type { SessionTicket } from './ticket.js';
import type { Mount, SandboxRuntime } from '../runtime/types.js';

export { resolveWorkspaceLayout, toFolderCheck, defaultLayoutPlaces, folderClaudeMdPath } from './check.js';
export { readSessionTicket } from './ticket.js';
export { buildSeed, sessionBranch, SANDBOX_HOME } from './seed.js';
export { SANDBOX_BASE_REF } from './mirror.js';
export type { WorkspaceLayout, LayoutRepo } from './layout.js';
export type { SessionTicket } from './ticket.js';
export type { Seed } from './seed.js';
export type { RepoBaseRequest, MirrorResult } from './mirror.js';

export const FOLDER_CLAUDE_MD_MAX_BYTES = 64 * 1024;

/**
 * The session volume at the layout's ROOT, and the container's working folder. ⚠ The working folder is
 * the ROOT (the volume's own mount point), never the start folder: Docker would create a missing
 * working folder as root inside the agent's volume. The driver runs the agent with `cwd: startDir`.
 */
export function sandboxMountsFor(layout: WorkspaceLayout, volume: string): { mounts: Mount[]; workdir: string } {
  return { mounts: [{ kind: 'volume', name: volume, target: layout.root }], workdir: layout.root };
}

export interface PrepareSessionArgs {
  resolved: ResolvedWorkspace;
  places: LayoutPlaces;
  bases: ReadonlyMap<number, RepoBaseRequest>;
  /** The base's words per repository ("main", "your PR #12"), and its one-line note. */
  baseLabels?: ReadonlyMap<number, { label: string; note: string | null }>;
  branch: string;
  ticket: SessionTicket;
  mode: 'implement' | 'fill_gaps';
  userClaudeMd: boolean;
  userSkills: boolean;
  /** The services for the seed, or a function asked AFTER the mirror (WP6 reads the picked compose
   *  files inside the sandbox, so the repositories must be there first). */
  services: readonly SeedService[] | null | ((mirror: MirrorResult) => Promise<readonly SeedService[] | null>);
  identity?: { name: string; email: string };
  seams?: MirrorSeams;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

export interface PreparedSession {
  mirror: MirrorResult;
  seed: Seed;
  /** Plain lines for the boot steps (left out, skipped). */
  notes: string[];
}

export async function prepareSessionWorkspace(runtime: SandboxRuntime, container: string, a: PrepareSessionArgs): Promise<PreparedSession> {
  const layout = a.resolved.layout;
  const notes = [...layout.notes];
  await prepareSandboxGit(runtime, container, layout, a.identity ?? { name: 'Limn sandbox', email: 'sandbox@limn.invalid' });
  const mirror = await mirrorRepos(runtime, container, layout, a.bases, a.branch, { seams: a.seams, onProgress: a.onProgress, signal: a.signal });
  for (const f of mirror.failed) notes.push(`${f.fullName} could not be cloned: ${f.reason}`);
  const services = typeof a.services === 'function' ? await a.services(mirror) : a.services;
  const seedNotes = [...notes];
  if (layout.outside.length > 0) {
    notes.push(`Not in this workspace, left out: ${layout.outside.map((o) => o.fullName).join(', ')}.`);
  }

  a.onProgress?.('Copying your notes');
  const reader = readerFiles(a.places.claude, {
    memoryProjects: layout.memoryProjects,
    userClaudeMd: a.userClaudeMd,
    userSkills: a.userSkills,
  });
  const skippedMemories = reader.memories.reduce((n, m) => n + m.skipped, 0);
  if (skippedMemories > 0) notes.push(`${skippedMemories} memory files were too large and were left out.`);
  if (reader.skippedSkills > 0) notes.push(`${reader.skippedSkills} skill files were too large and were left out.`);
  await runtime.copyIn(container, reader.files);

  const folderMd = a.userClaudeMd ? folderClaudeMdPath(a.resolved) : null;
  const folderText = folderMd ? readSmallFile(folderMd, FOLDER_CLAUDE_MD_MAX_BYTES)?.toString('utf8') ?? null : null;

  const bases = new Map<number, SeedRepoBase>();
  for (const r of mirror.repos) {
    const req = a.bases.get(r.repoId);
    const words = a.baseLabels?.get(r.repoId);
    bases.set(r.repoId, { sha: r.sha, label: words?.label ?? (req?.baseRef === 'HEAD' || req == null ? 'the default branch' : req.baseRef), note: words?.note ?? null });
  }
  // The seed names only what IS in the sandbox.
  const cloned = new Set(mirror.repos.map((r) => r.repoId));
  const seed = buildSeed({
    layout: { ...layout, repos: layout.repos.filter((r) => cloned.has(r.repoId)), notes: seedNotes },
    bases,
    branch: a.branch,
    ticket: a.ticket,
    mode: a.mode,
    memories: reader.memories,
    userClaudeMd: reader.userClaudeMd,
    folderClaudeMd: folderText,
    skills: reader.skills,
    services,
  });
  await runtime.copyIn(container, seed.files);
  return { mirror, seed, notes };
}
