import type { SandboxMemoryProject, SandboxServiceStackChoice, SandboxWorkspaceSettings, SandboxWorkspaceSettingsBody } from '@pierre-review/shared';

// SETTINGS → SANDBOX'S PURE HALF (SandboxSection.tsx): the draft from the stored setting, the whole-setting
// PUT body from the draft (the PUT REPLACES, so every field is sent), the dirty test and the memory ticks.
// React-free so test/sandboxSettingsForm.test.ts pins it.

export interface SandboxDraft {
  /** null = the default (every project found with notes). */
  memoryProjects: string[] | null;
  userClaudeMd: boolean;
  userSkills: boolean;
  globalProxyEnv: boolean;
  /** As typed ('' = Limn's default). */
  cpus: string;
  memoryGb: string;
  diskGb: string;
  services: SandboxServiceStackChoice[];
}

const num = (n: number | null): string => (n == null ? '' : String(n));

export function sandboxDraftOf(s: SandboxWorkspaceSettings): SandboxDraft {
  return {
    memoryProjects: s.memoryProjects == null ? null : [...s.memoryProjects],
    userClaudeMd: s.userClaudeMd,
    userSkills: s.userSkills,
    globalProxyEnv: s.globalProxyEnv,
    cpus: num(s.resources.cpus),
    memoryGb: num(s.resources.memoryGb),
    diskGb: num(s.resources.diskGb),
    services: s.services.map((x) => ({ repo: x.repo, file: x.file, egress: [...x.egress] })),
  };
}

const intOrNull = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/** The WHOLE setting (the PUT replaces it: a field left out would go back to its default). */
export function sandboxBodyOf(d: SandboxDraft): SandboxWorkspaceSettingsBody {
  return {
    memoryProjects: d.memoryProjects,
    userClaudeMd: d.userClaudeMd,
    userSkills: d.userSkills,
    globalProxyEnv: d.globalProxyEnv,
    resources: { cpus: intOrNull(d.cpus), memoryGb: intOrNull(d.memoryGb), diskGb: intOrNull(d.diskGb) },
    services: d.services,
  };
}

export function sandboxDraftDirty(d: SandboxDraft, saved: SandboxWorkspaceSettings): boolean {
  return JSON.stringify(sandboxBodyOf(d)) !== JSON.stringify(sandboxBodyOf(sandboxDraftOf(saved)));
}

/** Compose files picked in the list, added to the draft's services (no duplicates, the cap kept). Pure. */
export function addComposePicks(services: readonly SandboxServiceStackChoice[], picks: ReadonlyArray<{ repo: string; file: string }>, max: number): SandboxServiceStackChoice[] {
  const out = [...services];
  for (const p of picks) {
    if (out.length >= max) break;
    if (out.some((s) => s.repo === p.repo && s.file === p.file)) continue;
    out.push({ repo: p.repo, file: p.file, egress: [] });
  }
  return out;
}

export interface SandboxMemoryTick extends SandboxMemoryProject {
  /** The memoryProjects value after this box is set to `on`. */
  toggle: (on: boolean) => string[];
}

/**
 * The check's memory projects with the DRAFT's ticks: null = what the check ticked (the saved choice, else
 * every project with notes), so the first change turns that into an explicit list.
 */
export function sandboxMemoryTicks(found: readonly SandboxMemoryProject[], chosen: string[] | null): SandboxMemoryTick[] {
  const current = chosen ?? found.filter((m) => m.ticked).map((m) => m.dir);
  return found.map((m) => ({
    ...m,
    ticked: current.includes(m.dir),
    toggle: (on: boolean) => (on ? [...new Set([...current, m.dir])] : current.filter((d) => d !== m.dir)),
  }));
}
