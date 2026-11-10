// THE CLONE / MEMORY CHECK and the SESSION'S LAYOUT — one computation (docs/SANDBOX.md § The
// workspace mirror). Settings → Workspace → Sandbox shows `toFolderCheck(…)`; a session boots from
// the `WorkspaceLayout` of the SAME `resolveWorkspaceLayout` call, so what the reader saw is what the
// sandbox gets. Disk + DB only: no git process, no network.
//
// There is no folder setting (removed 2026-11-10; the stored `local_folder` / `start_dir` columns are
// dormant): the reader's clones are FOUND through their Claude projects (discover.ts), and the folder
// the layout mirrors is picked from them. The memories offered are the projects of those clones (and of
// a team folder that holds them) — never another project that happens to sit nearby.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import type { SandboxFolderCheck } from '@pierre-review/shared';
import { resolveDataDir } from '../../data-dir.js';
import { discoverReaderClones, pickReaderFolder } from './discover.js';
import { matchClones, localFolderProblem, planLayout, unmatchedOf, type WorkspaceLayout, type WorkspaceRepo, type CloneMatch } from './layout.js';
import { defaultClaudePlaces, listUserSkills, memoryCount, type ClaudePlaces } from './memories.js';
import { scanFolder, type FolderScan } from './scan.js';

export interface LayoutSettings {
  /** The ticked memory projects; null = the default (every project of a workspace clone with memories). */
  memoryProjects: string[] | null;
}

export interface LayoutPlaces {
  claude: ClaudePlaces;
  home: string;
  dataDir: string;
}

export function defaultLayoutPlaces(env: NodeJS.ProcessEnv = process.env): LayoutPlaces {
  const home = homedir();
  return { claude: defaultClaudePlaces(env), home, dataDir: resolveDataDir(env, home) };
}

export interface ResolvedWorkspace {
  /** The folder the layout mirrors (realpath), found from the reader's clones, or null. */
  folder: string | null;
  match: CloneMatch | null;
  scan: FolderScan | null;
  /** Every project of a workspace clone (or of a team folder) with memories, with its tick. */
  projects: Array<{ dir: string; key: string; memoryCount: number; ticked: boolean }>;
  layout: WorkspaceLayout;
}

/** Validate and realpath the folder. */
export function resolveFolder(folder: string | null, places: Pick<LayoutPlaces, 'home' | 'dataDir'>): { folder: string | null; problem: string | null } {
  if (folder == null || folder.trim() === '') return { folder: null, problem: null };
  const given = normalize(folder.trim());
  const early = localFolderProblem(given, places);
  if (early) return { folder: null, problem: early };
  if (!existsSync(given)) return { folder: null, problem: `${given} does not exist on this computer.` };
  let real: string;
  try {
    real = realpathSync(given);
    if (!statSync(real).isDirectory()) return { folder: null, problem: `${given} is not a folder.` };
  } catch {
    return { folder: null, problem: `Limn cannot read ${given}.` };
  }
  const late = real === given ? null : localFolderProblem(real, places);
  return late ? { folder: null, problem: late } : { folder: real, problem: null };
}

export function resolveWorkspaceLayout(
  repos: readonly WorkspaceRepo[],
  settings: LayoutSettings,
  places: LayoutPlaces = defaultLayoutPlaces(),
): ResolvedWorkspace {
  const found = discoverReaderClones(repos, places.claude, places.home);
  const { folder } = resolveFolder(pickReaderFolder(found, places), places);
  let scan: FolderScan | null = null;
  let match: CloneMatch | null = null;
  if (folder != null) {
    scan = scanFolder(folder);
    match = matchClones(repos, scan.clones);
  }
  const ticks = settings.memoryProjects == null ? null : new Set(settings.memoryProjects.map((p) => normalize(p)));
  const projects: ResolvedWorkspace['projects'] = [];
  const seen = new Set<string>();
  for (const p of found.projects) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    const n = memoryCount(places.claude, p.key);
    if (n === 0) continue;
    projects.push({ dir: p.dir, key: p.key, memoryCount: n, ticked: ticks == null ? true : ticks.has(p.dir) });
  }
  const layout = planLayout({
    repos,
    folder,
    match,
    memoryProjects: projects.filter((p) => p.ticked).map(({ dir, key, memoryCount: c }) => ({ dir, key, memoryCount: c })),
  });
  return { folder, match, scan, projects, layout };
}

/** The folder's own CLAUDE.md (outside every repository: only when the folder is the layout's root). */
export function folderClaudeMdPath(r: Pick<ResolvedWorkspace, 'folder' | 'layout'>): string | null {
  if (r.folder == null || r.layout.root !== r.folder) return null;
  const p = join(r.folder, 'CLAUDE.md');
  return existsSync(p) ? p : null;
}

/** The check's wire shape. */
export function toFolderCheck(workspaceId: number, r: ResolvedWorkspace, places: LayoutPlaces): SandboxFolderCheck {
  return {
    workspaceId,
    folder: r.folder,
    matched: r.match?.matched ?? [],
    notCloned: unmatchedOf(r.layout),
    outside: r.match?.outside ?? [],
    memories: r.projects.map((p) => ({ dir: p.dir, key: p.key, memoryCount: p.memoryCount, ticked: p.ticked })),
    userClaudeMd: existsSync(join(places.claude.claudeDir, 'CLAUDE.md')),
    folderClaudeMd: folderClaudeMdPath(r) != null,
    userSkills: listUserSkills(places.claude),
    startDir: r.layout.startDir,
    truncated: r.scan?.truncated ?? false,
  };
}
