// A WORKSPACE SESSION'S SETUP: Settings → Workspace → Sandbox, and the folder / memory check
// (docs/SANDBOX.md § The workspace mirror). Per WORKSPACE, nothing inherited.
//
//   GET  /api/workspaces/:id/sandbox                    → SandboxWorkspaceSettings
//   PUT  /api/workspaces/:id/sandbox                    body SandboxWorkspaceSettingsBody → SandboxWorkspaceSettings
//   POST /api/workspaces/:id/sandbox/check              body SandboxFolderCheckBody → SandboxFolderCheck
//   POST /api/workspaces/:id/sandbox/allowed-hosts      body { rule } → SandboxWorkspaceSettings
//   DELETE /api/workspaces/:id/sandbox/allowed-hosts    body { rule } → SandboxWorkspaceSettings
//
import type { SandboxServiceStackChoice } from './sandbox-services.js';

// The LOCAL FOLDER decides only the LAYOUT inside the sandbox and which Claude memories come with it.
// The code always comes from Limn's own clone cache, never from the reader's checkout.

/** The reader's resource choice for one session. null = Limn's default. */
export interface SandboxResourceChoice {
  cpus: number | null;
  memoryGb: number | null;
  diskGb: number | null;
}

export const SANDBOX_RESOURCE_DEFAULTS = { cpus: 4, memoryGb: 8, diskGb: 30 } as const;
export const SANDBOX_RESOURCE_LIMITS = {
  cpus: { min: 1, max: 64 },
  memoryGb: { min: 2, max: 256 },
  diskGb: { min: 5, max: 2048 },
} as const;

export interface SandboxWorkspaceSettings {
  workspaceId: number;
  /** The folder that holds the reader's clones (absolute), or null: repositories go under /workspace. */
  localFolder: string | null;
  /** The Claude project folders the reader ticked. null = the default: every project found with memories. */
  memoryProjects: string[] | null;
  /** Bring `~/.claude/CLAUDE.md` (and the local folder's own CLAUDE.md). Default on. */
  userClaudeMd: boolean;
  /** Bring `~/.claude/skills/`. Default off (opt-in per workspace). */
  userSkills: boolean;
  /** The agent's starting folder (absolute, inside the layout). null = the default rule. */
  startDir: string | null;
  /** Set HTTP_PROXY / HTTPS_PROXY for every program in the sandbox. Default off (docs/SANDBOX.md § How
   *  tools in the sandbox reach the internet). */
  globalProxyEnv: boolean;
  resources: SandboxResourceChoice;
  /** The compose files Limn may run for a session (docs/SANDBOX.md § Services). Empty = none. */
  services: SandboxServiceStackChoice[];
  /** "Always allow" hosts (sandbox_allowed_hosts), normalised, sorted. */
  alwaysAllowedHosts: string[];
}

/** PUT replaces the whole setting: a field left out goes back to its default. */
export interface SandboxWorkspaceSettingsBody {
  localFolder?: string | null;
  memoryProjects?: string[] | null;
  userClaudeMd?: boolean;
  userSkills?: boolean;
  startDir?: string | null;
  globalProxyEnv?: boolean;
  resources?: Partial<SandboxResourceChoice>;
  services?: SandboxServiceStackChoice[];
}

export const SANDBOX_MEMORY_PROJECTS_MAX = 50;
export const SANDBOX_PATH_MAX = 1024;

export interface SandboxFolderCheckBody {
  /** The folder to check. Omitted: the saved one. null: check with no folder. */
  folder?: string | null;
}

/** A workspace repository found in the folder, matched by its git remote. */
export interface SandboxMatchedRepo {
  repoId: number;
  fullName: string;
  /** The local clone: the repository is placed at THIS path inside the sandbox. */
  localPath: string;
  /** Other clones of the same repository in the folder (not used). */
  alsoAt: string[];
}

/** A workspace repository with no clone in the folder. It is still cloned, at `sandboxPath`. */
export interface SandboxUnmatchedRepo {
  repoId: number;
  fullName: string;
  sandboxPath: string;
}

/** A clone in the folder whose repository is NOT in this workspace: named, left out. */
export interface SandboxOutsideClone {
  /** `owner/name` from its remote. */
  fullName: string;
  localPath: string;
}

/** A Claude project under the folder with saved memories (`~/.claude/projects/<key>/memory`). */
export interface SandboxMemoryProject {
  /** The project's folder (absolute). */
  dir: string;
  /** Claude Code's project key for that folder. */
  key: string;
  memoryCount: number;
  /** Ticked: by the saved choice, else by the default (every project with memories). */
  ticked: boolean;
}

export interface SandboxFolderCheck {
  workspaceId: number;
  /** The folder checked (absolute, normalised), or null. */
  folder: string | null;
  /** One plain line when the folder cannot be used (the rest is then empty). */
  problem: string | null;
  matched: SandboxMatchedRepo[];
  notCloned: SandboxUnmatchedRepo[];
  outside: SandboxOutsideClone[];
  memories: SandboxMemoryProject[];
  /** `~/.claude/CLAUDE.md` exists. */
  userClaudeMd: boolean;
  /** The folder has its own CLAUDE.md (outside every repository). */
  folderClaudeMd: boolean;
  /** Skill folders in `~/.claude/skills/`. */
  userSkills: string[];
  /** Where the agent starts, and why. */
  startDir: string;
  startDirReason: 'setting' | 'memories' | 'folder' | 'default';
  /** The walk stopped at its limit: some clones may be missing. */
  truncated: boolean;
}

// ---- the container runtime, for the build tab and Settings → Sandbox ----------------------------------
//
//   GET /api/sandbox/runtime → SandboxRuntimeStatus   (local process checks only; cached a few seconds)

/** Which container runtime this computer has, in the words the reader sees. */
export interface SandboxRuntimeStatus {
  /** A session can start: the CLI is there and its daemon answers. */
  available: boolean;
  /** 'docker' (Docker, Colima, Podman, Rancher Desktop all speak it) — null when none was found. */
  kind: 'docker' | 'microsandbox' | null;
  /** The product's name and version: "Docker Desktop 29.0.1", "Colima", "Podman 5.2". Null when none. */
  label: string | null;
  /** One plain line about the product's licence (Docker Desktop), or null. */
  licenceNote: string | null;
  /** One plain line saying what is wrong, when `available` is false. */
  problem: string | null;
  /** What the runtime can give a sandbox (null when it does not say). */
  cpus: number | null;
  memoryGb: number | null;
}
