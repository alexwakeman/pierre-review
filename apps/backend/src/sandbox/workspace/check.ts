// THE FOLDER / MEMORY CHECK and the SESSION'S LAYOUT — one computation (docs/SANDBOX.md § The
// workspace mirror). Settings → Workspace → Sandbox shows `toFolderCheck(…)`; a session boots from
// the `WorkspaceLayout` of the SAME `resolveWorkspaceLayout` call, so what the reader saw is what the
// sandbox gets. Disk + DB only: no git process, no network.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import type { SandboxFolderCheck } from '@pierre-review/shared';
import { resolveDataDir } from '../../data-dir.js';
import { matchClones, localFolderProblem, planLayout, unmatchedOf, type WorkspaceLayout, type WorkspaceRepo, type CloneMatch } from './layout.js';
import { defaultClaudePlaces, listUserSkills, memoryCount, memoryProjectKeys, type ClaudePlaces } from './memories.js';
import { scanFolder, type FolderScan } from './scan.js';

export interface LayoutSettings {
  localFolder: string | null;
  memoryProjects: string[] | null;
  startDir: string | null;
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
  /** The folder as checked (realpath), or null. */
  folder: string | null;
  problem: string | null;
  match: CloneMatch | null;
  scan: FolderScan | null;
  /** Every project with memories under the folder, with its tick. */
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
  const { folder, problem } = resolveFolder(settings.localFolder, places);
  let scan: FolderScan | null = null;
  let match: CloneMatch | null = null;
  const projects: ResolvedWorkspace['projects'] = [];
  if (folder != null) {
    const keys = memoryProjectKeys(places.claude);
    scan = scanFolder(folder, { projectKeys: keys });
    match = matchClones(repos, scan.clones);
    const ticks = settings.memoryProjects == null ? null : new Set(settings.memoryProjects.map((p) => normalize(p)));
    for (const p of scan.projectDirs) {
      const n = memoryCount(places.claude, p.key);
      if (n === 0) continue;
      projects.push({ dir: p.dir, key: p.key, memoryCount: n, ticked: ticks == null ? true : ticks.has(p.dir) });
    }
    projects.sort((a, b) => (a.dir < b.dir ? -1 : 1));
  }
  const layout = planLayout({
    repos,
    folder,
    match,
    memoryProjects: projects.filter((p) => p.ticked).map(({ dir, key, memoryCount: c }) => ({ dir, key, memoryCount: c })),
    startDirSetting: settings.startDir,
  });
  return { folder, problem, match, scan, projects, layout };
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
    problem: r.problem,
    matched: r.match?.matched ?? [],
    notCloned: unmatchedOf(r.layout),
    outside: r.match?.outside ?? [],
    memories: r.projects.map((p) => ({ dir: p.dir, key: p.key, memoryCount: p.memoryCount, ticked: p.ticked })),
    userClaudeMd: existsSync(join(places.claude.claudeDir, 'CLAUDE.md')),
    folderClaudeMd: folderClaudeMdPath(r) != null,
    userSkills: listUserSkills(places.claude),
    startDir: r.layout.startDir,
    startDirReason: r.layout.startDirReason,
    truncated: r.scan?.truncated ?? false,
  };
}
