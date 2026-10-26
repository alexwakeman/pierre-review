import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { SPRINT_BRIEF_MODEL, SPRINT_THEME_VERSION, type SprintTheme } from '@pierre-review/shared';

// REPORTS → THIS SPRINT — THE THEMES' STORE HALF (docs/CLAUDE-REVIEW.md § Sprint themes). ONE builder of
// what the theme pass is SENT (`sprintThemeInput`) and therefore of whether the stored themes are
// CURRENT: they count only while `input_hash` equals today's hash AND `theme_version` is
// SPRINT_THEME_VERSION. The pass (review/sprint-themes/, local + agentic) writes; the graph
// (db/sprint-graph.ts) reads.
//
//   • THE INPUT is the sprint's tickets (never ghosts), by key: the key, the title and the CURRENT brief's
//     summary (null while a brief is pending). The HASH covers the keys and the summaries — a ticket with
//     no brief yet hashes its title in the summary's place, so a brief landing later re-runs the pass.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY inside the readers (a pure test never opens it).

export const SPRINT_THEME_TITLE_MAX_CHARS = 200;

export interface SprintThemeTicket {
  ident: string;
  key: string;
  title: string;
  /** The current brief's summary; null while pending. */
  summary: string | null;
}

export interface SprintThemeInput {
  /** By key (numeric-aware). */
  tickets: SprintThemeTicket[];
  /** sha256 hex of the keys + summaries. */
  inputHash: string;
}

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let cut = max;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
};

/** The theme pass's input for a sprint. Pure. */
export function sprintThemeInput(tickets: ReadonlyArray<SprintThemeTicket>): SprintThemeInput {
  const list = tickets
    .map((t) => ({
      ident: t.ident,
      key: t.key,
      title: clip(t.title.trim().replace(/\s+/g, ' '), SPRINT_THEME_TITLE_MAX_CHARS),
      summary: t.summary == null || t.summary.trim() === '' ? null : t.summary.trim(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }) || a.ident.localeCompare(b.ident));
  const inputHash = createHash('sha256')
    .update(JSON.stringify(list.map((t) => [t.key, t.summary ?? `title:${t.title}`])))
    .digest('hex');
  return { tickets: list, inputHash };
}

export interface SprintThemeRow {
  inputHash: string;
  themeVersion: number;
  themesJson: unknown;
  assignmentsJson: unknown;
  createdAt: Date;
}

export interface CurrentSprintThemes {
  themes: SprintTheme[];
  /** ident → theme name. */
  byIdent: Map<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v);

/** Is this stored row current for today's input? Pure. */
export function areThemesCurrent(row: Pick<SprintThemeRow, 'inputHash' | 'themeVersion'> | null | undefined, inputHash: string): boolean {
  return row != null && row.themeVersion === SPRINT_THEME_VERSION && row.inputHash === inputHash;
}

/** A stored row → themes (largest first, then name; each with its summary, null when none was
 *  stored) + the ident map. Tolerant: malformed entries and assignments to a theme that is not listed
 *  are dropped; a theme no ticket is in is dropped. Pure. */
export function sprintThemesOf(row: Pick<SprintThemeRow, 'themesJson' | 'assignmentsJson'>): CurrentSprintThemes {
  const names = new Set<string>();
  const summaries = new Map<string, string | null>();
  for (const t of Array.isArray(row.themesJson) ? row.themesJson : []) {
    if (isObj(t) && typeof t.name === 'string' && t.name.trim() !== '' && !names.has(t.name)) {
      names.add(t.name);
      summaries.set(t.name, typeof t.summary === 'string' && t.summary.trim() !== '' ? t.summary : null);
    }
  }
  const byIdent = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const a of Array.isArray(row.assignmentsJson) ? row.assignmentsJson : []) {
    if (!isObj(a) || typeof a.ident !== 'string' || typeof a.theme !== 'string' || !names.has(a.theme)) continue;
    if (byIdent.has(a.ident)) continue;
    byIdent.set(a.ident, a.theme);
    counts.set(a.theme, (counts.get(a.theme) ?? 0) + 1);
  }
  const themes = [...names]
    .filter((n) => (counts.get(n) ?? 0) > 0)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
    .map((name) => ({ name, summary: summaries.get(name) ?? null }));
  return { themes, byIdent };
}

/** The stored row (any currency), this account + workspace only. */
export async function storedSprintThemes(accountId: number, workspaceId: number): Promise<SprintThemeRow | null> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintThemes;
  const rows = await db
    .select({
      inputHash: t.inputHash,
      themeVersion: t.themeVersion,
      themesJson: t.themesJson,
      assignmentsJson: t.assignmentsJson,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  return (rows[0] as SprintThemeRow | undefined) ?? null;
}

/** The CURRENT themes for today's input, or null. */
export async function currentSprintThemes(accountId: number, workspaceId: number, inputHash: string): Promise<CurrentSprintThemes | null> {
  const row = await storedSprintThemes(accountId, workspaceId);
  if (!areThemesCurrent(row, inputHash)) return null;
  const out = sprintThemesOf(row!);
  return out.themes.length > 0 ? out : null;
}

export interface StoredSprintThemes {
  themes: SprintTheme[];
  assignments: Array<{ ident: string; theme: string }>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** What answered (Phase 4): the model that RAN and its provider. Absent ⇒ the Claude constant. */
  model?: string;
  provider?: 'claude' | 'codex';
}

/** Upsert the workspace's ONE themes row. */
export async function storeSprintThemes(
  accountId: number,
  workspaceId: number,
  inputHash: string,
  v: StoredSprintThemes,
  now: Date = new Date(),
): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintThemes;
  const values = {
    inputHash,
    themeVersion: SPRINT_THEME_VERSION,
    themesJson: v.themes,
    assignmentsJson: v.assignments,
    model: v.model ?? SPRINT_BRIEF_MODEL,
    provider: v.provider ?? null,
    costUsd: v.costUsd,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    createdAt: now,
  };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: values })
    .execute();
}
