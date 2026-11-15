// A WORKSPACE SESSION'S FILES (docs/SANDBOX.md § The workspace mirror). What the session manager (WP7)
// calls, in order:
//
//   1. `resolveWorkspaceLayout(repos, settings)`  (check.ts) — the SAME computation Settings shows;
//   2. `sandboxMountsFor(layout, volume, store)`   — the one session volume at the layout's root, the
//                                                    repo store read-only, and the working folder;
//   3. `readSessionTicket(…)`                      (ticket.ts) — the ticket, read fresh;
//   4. `prepareSessionWorkspace(runtime, container, …)` — the git identity, the repositories, the reader's
//      files, then the seed (seed.ts). Returns the seed so the driver appends `systemPrompts[provider]`.
import { posix } from 'node:path';
import { readSmallFile } from './memories.js';
import { mirrorRepos, prepareSandboxGit, readerFiles, type MirrorResult, type MirrorSeams, type RepoBaseRequest } from './mirror.js';
import { buildSeed, type FixSeedInput, type Seed, type SeedHotfix, type SeedProjectSkill, type SeedRepoBase, type SeedService } from './seed.js';
import { mainCheckoutPaths } from './hotfix.js';
import type { LayoutPlaces, ResolvedWorkspace } from './check.js';
import { folderClaudeMdPath } from './check.js';
import type { WorkspaceLayout } from './layout.js';
import type { SessionTicket } from './ticket.js';
import type { Mount, SandboxRuntime, SessionOwner } from '../runtime/types.js';
import { STORE_MOUNT } from '../runtime/labels.js';
import type { StoreSeams } from './store.js';

export { resolveWorkspaceLayout, toFolderCheck, defaultLayoutPlaces, folderClaudeMdPath } from './check.js';
export { readSessionTicket } from './ticket.js';
export { buildSeed, sessionBranch, fixSessionBranch, SANDBOX_HOME } from './seed.js';
export { SANDBOX_BASE_REF } from './mirror.js';
export type { WorkspaceLayout, LayoutRepo } from './layout.js';
export type { SessionTicket } from './ticket.js';
export type { Seed, FixSeedInput, SeedHotfix } from './seed.js';
export { mainCheckoutPaths, MAIN_CHECKOUT_SUFFIX } from './hotfix.js';
export type { RepoBaseRequest, MirrorResult } from './mirror.js';

export const FOLDER_CLAUDE_MD_MAX_BYTES = 64 * 1024;

/**
 * The session volume at the layout's ROOT, and the container's working folder. ⚠ The working folder is
 * the ROOT (the volume's own mount point), never the start folder: Docker would create a missing
 * working folder as root inside the agent's volume. The driver runs the agent with `cwd: startDir`.
 * The repo store (when given) is mounted READ-ONLY at `STORE_MOUNT` (docs/SANDBOX.md § The repo store).
 */
export function sandboxMountsFor(layout: WorkspaceLayout, volume: string, store: string | null = null): { mounts: Mount[]; workdir: string } {
  const mounts: Mount[] = [{ kind: 'volume', name: volume, target: layout.root }];
  if (store != null) {
    if (layout.root === STORE_MOUNT || layout.root.startsWith(`${STORE_MOUNT}/`)) throw new Error('The workspace cannot sit inside the repo store.');
    mounts.push({ kind: 'volume', name: store, target: STORE_MOUNT, readOnly: true });
  }
  return { mounts, workdir: layout.root };
}

/** The reader's clones per repository, from the layout's match (the first path, then `alsoAt`). */
export function localClonesOf(resolved: ResolvedWorkspace): Map<number, string[]> {
  return new Map((resolved.match?.matched ?? []).map((m) => [m.repoId, [m.localPath, ...m.alsoAt]]));
}

export interface PrepareSessionArgs {
  resolved: ResolvedWorkspace;
  places: LayoutPlaces;
  bases: ReadonlyMap<number, RepoBaseRequest>;
  /** The base's words per repository ("main", "your PR #12"), and its one-line note. */
  baseLabels?: ReadonlyMap<number, { label: string; note: string | null }>;
  branch: string;
  /** What the agent is told: a story's ticket (`ticket` + `mode`), or an AI Fix's task (`fix`). seed.ts, the ONE fold. */
  ticket?: SessionTicket;
  mode?: 'implement' | 'fill_gaps';
  /** A story session opens with a planning turn (seed.ts `planFirst`). */
  planFirst?: boolean;
  /** The reference documents: copy the reference documents in AFTER the mirror, before the services and the
   *  seed (docs.ts). Returns where they are, or null when none were copied. */
  docs?: (mirror: MirrorResult) => Promise<{ dir: string } | null>;
  fix?: FixSeedInput;
  userClaudeMd: boolean;
  userSkills: boolean;
  /** The services for the seed, or a function asked AFTER the mirror (WP6 reads the picked compose
   *  files inside the sandbox, so the repositories must be there first). */
  services: readonly SeedService[] | null | ((mirror: MirrorResult) => Promise<readonly SeedService[] | null>);
  identity?: { name: string; email: string };
  seams?: MirrorSeams;
  /** The repo store, when the sandbox was started with it mounted. */
  store?: { owner: SessionOwner; seams?: StoreSeams } | null;
  /** The repositories' own skills at their base commits (default: `projectSkillsAt` in Limn's clone
   *  cache, file names only). A seam for tests. */
  projectSkills?: (repos: MirrorResult['repos']) => Promise<SeedProjectSkill[]>;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /**
   * A HOTFIX build (docs/STORY-BUILD.md § Hotfix builds): `bases` put each repository with a release at its
   * release commit; `mainBases` (those repositories only) are mirrored AGAIN beside it, at the default branch
   * (`mainCheckoutPaths`). `releases` names each one's tag; a repository without one is READ ONLY.
   */
  hotfix?: {
    mainBases: ReadonlyMap<number, RepoBaseRequest>;
    releases: ReadonlyMap<number, { tagName: string; hotfixBranch: string }>;
    mainLabels: ReadonlyMap<number, string>;
  } | null;
}

export interface PreparedSession {
  mirror: MirrorResult;
  /** A hotfix build's main checkouts (one per repository with a release that cloned). */
  mainMirror?: MirrorResult;
  seed: Seed;
  /** Plain lines for the boot steps (left out, skipped). */
  notes: string[];
}

export async function prepareSessionWorkspace(runtime: SandboxRuntime, container: string, a: PrepareSessionArgs): Promise<PreparedSession> {
  const layout = a.resolved.layout;
  const notes = [...layout.notes];
  await prepareSandboxGit(runtime, container, layout, a.identity ?? { name: 'Ensemble sandbox', email: 'sandbox@limn.invalid' });
  const mirror = await mirrorRepos(runtime, container, layout, a.bases, a.branch, {
    seams: a.seams,
    onProgress: a.onProgress,
    signal: a.signal,
    store: a.store ?? null,
    localClones: localClonesOf(a.resolved),
  });
  for (const f of mirror.failed) notes.push(`${f.fullName} could not be cloned: ${f.reason}`);
  notes.push(...mirror.notes);
  // HOTFIX: the main checkouts, beside the release checkouts that cloned.
  let mainMirror: MirrorResult | undefined;
  if (a.hotfix != null && a.hotfix.mainBases.size > 0) {
    const want = new Set(mirror.repos.map((r) => r.repoId).filter((id) => a.hotfix!.mainBases.has(id)));
    const paths = mainCheckoutPaths(layout, want);
    const mainLayout: WorkspaceLayout = { ...layout, repos: layout.repos.filter((r) => paths.has(r.repoId)).map((r) => ({ ...r, path: paths.get(r.repoId)! })) };
    a.onProgress?.('Loading the main checkouts');
    mainMirror = await mirrorRepos(runtime, container, mainLayout, a.hotfix.mainBases, a.branch, {
      seams: a.seams,
      signal: a.signal,
      store: a.store ?? null,
      localClones: localClonesOf(a.resolved),
    });
    for (const f of mainMirror.failed) notes.push(`The main checkout of ${f.fullName} could not be cloned: ${f.reason}`);
  }
  const docs = a.docs ? await a.docs(mirror) : null;
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

  const projectSkills = await (a.projectSkills ?? cachedProjectSkills)(mirror.repos).catch((): SeedProjectSkill[] => []);

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
  const common = {
    layout: { ...layout, repos: layout.repos.filter((r) => cloned.has(r.repoId)), notes: seedNotes },
    bases,
    branch: a.branch,
    memories: reader.memories,
    userClaudeMd: reader.userClaudeMd,
    folderClaudeMd: folderText,
    skills: reader.skills,
    projectSkills,
    services,
  };
  if (a.fix == null && a.ticket == null) throw new Error('A session needs a ticket or a fix to seed.');
  const hotfix = a.hotfix != null ? hotfixSeedOf(mirror, mainMirror ?? null, a.hotfix) : null;
  const seed =
    a.fix != null
      ? buildSeed({ ...common, kind: 'fix', fix: a.fix })
      : buildSeed({ ...common, ticket: a.ticket!, mode: a.mode ?? 'implement', planFirst: a.planFirst === true, docs, ...(hotfix ? { hotfix } : {}) });
  await runtime.copyIn(container, seed.files);
  return { mirror, seed, notes, ...(mainMirror ? { mainMirror } : {}) };
}

/** The seed's hotfix facts: every cloned repository, its release (or read only) and its main checkout. Pure. */
export function hotfixSeedOf(
  mirror: Pick<MirrorResult, 'repos'>,
  mainMirror: Pick<MirrorResult, 'repos'> | null,
  h: NonNullable<PrepareSessionArgs['hotfix']>,
): SeedHotfix {
  return {
    repos: mirror.repos.map((r) => {
      const rel = h.releases.get(r.repoId);
      const main = mainMirror?.repos.find((m) => m.repoId === r.repoId);
      return {
        repoId: r.repoId,
        fullName: r.fullName,
        release: rel ? { tagName: rel.tagName, path: r.path, hotfixBranch: rel.hotfixBranch } : null,
        main: rel && main ? { path: main.path, label: h.mainLabels.get(r.repoId) ?? 'the default branch', sha: main.sha } : null,
      };
    }),
  };
}

/** The cloned repositories' own skills, read from Limn's clone cache at each repository's base commit. */
async function cachedProjectSkills(repos: MirrorResult['repos']): Promise<SeedProjectSkill[]> {
  // Lazy, like the mirror's clone-manager import: it is not needed to build a seed in a test.
  const { projectSkillsAt } = await import('./project-skills.js');
  const { repoCloneDir } = await import('../../review/clone-manager.js');
  const per = await Promise.all(
    repos.map(async (r) => {
      const [owner, name] = r.fullName.split('/');
      if (!owner || !name) return [];
      const skills = await projectSkillsAt(repoCloneDir(owner, name), r.sha).catch(() => []);
      return skills.map((k) => ({ repo: r.fullName, name: k.name, path: posix.join(r.path, k.path) }));
    }),
  );
  return per.flat();
}
