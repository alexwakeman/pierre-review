import type {
  BotThemeCategory,
  BotThemeCategoryCount,
  BotThemeSeverity,
  BotThemeSeverityCount,
} from '@pierre-review/shared';
import type { LlmClient } from '../llm/seam.js';
import type { BotThemesBuild } from './build.js';

// The model's raw theme BEFORE server-side ref resolution. `memberIds` are the payload item ids
// (cluster ids for bots, comment ids for humans) the model grouped into this theme — the server
// expands them into concrete `prs` + `threads` (see themes/resolve.ts). `examplePrNumbers` is the
// model's highlight ordering hint. Both are dropped from the final wire BotTheme.
export interface ParsedTheme {
  title: string;
  category: BotThemeCategory;
  severity: BotThemeSeverity;
  summary: string;
  occurrences: number;
  bots: string[];
  areas: string[];
  examplePrNumbers: number[];
  memberIds: number[];
}

// The Haiku pass for the Bots "What they're flagging" summary — REVIVED merged with the
// deterministic Bots layer (the synthesis seam's 'workspace-bots' kind stays, still serving the
// drill-down cards) — plus the tolerant theme PARSE both themed summaries share: the HUMAN
// "Discussion themes" runner imports parseThemes/ParsedThemes, and the shared ref resolution
// (themes/resolve.ts) imports ParsedTheme. The model ONLY classifies + clusters into themes —
// every deterministic figure (volumes, area split, acted-on %, the per-theme comment counts) is
// computed in build.ts/routes.ts, so the model can't inflate the numbers. Strict JSON out,
// parsed defensively — tolerant of stray fences/prose and a truncated tail.

const CATEGORIES: BotThemeCategory[] = [
  'correctness',
  'security',
  'performance',
  'error_handling',
  'testing',
  'style',
  'docs',
  'maintainability',
  'other',
];
const SEVERITIES: BotThemeSeverity[] = ['critical', 'major', 'minor', 'nit'];
const SEVERITY_RANK: Record<BotThemeSeverity, number> = { critical: 3, major: 2, minor: 1, nit: 0 };

export const MAX_TOKENS = 4000; // headroom for ~10 themes WITH their memberIds — truncation can't complete the JSON

export const SYSTEM = `You summarise what a team's automated CODE-REVIEW BOTS (e.g. CodeRabbit, Greptile, Copilot) are flagging, from a JSON snapshot of DEDUPED comment clusters over the team's repositories.

Each cluster is { id, text, count, severityHint, areas, bots, prs }: a stable numeric id, a representative comment, how many near-identical comments it stands for, a coarse severity hint, the codebase areas (top-level dirs) and bots it spans, and example PR numbers.

Your job: group the clusters into a small set of recurring THEMES — a theme is a RECURRING CLASS of issue (e.g. "missing null/undefined checks", "unhandled promise rejections", "test coverage gaps", "naming nitpicks"), NOT one comment. Then write a 2–3 sentence narrative.

Return ONLY a JSON object (no prose, no code fences) of exactly this shape:
{
  "narrative": "<2-3 sentence markdown overview — the story: which bots are noisiest, what dominates, where the critical stuff clusters>",
  "themes": [
    {
      "title": "<short label, e.g. 'Missing null checks'>",
      "category": "correctness|security|performance|error_handling|testing|style|docs|maintainability|other",
      "severity": "critical|major|minor|nit",
      "summary": "<one sentence: what the bots keep saying and why it matters>",
      "occurrences": <integer — sum the 'count' of the clusters you folded in>,
      "bots": ["<bot label>", ...],
      "areas": ["<top-level dir>", ...],
      "examplePrNumbers": [<pr number>, ...],
      "memberIds": [<cluster id>, ...]
    }
  ]
}

"memberIds" MUST list the actual cluster "id"s you folded into this theme (up to ~15 of the most representative). This is load-bearing — it links the theme back to its source comments.

Rules: 4–10 themes, MOST CRITICAL FIRST. Ground EVERY field in the JSON — invent no PRs, bots, or areas not present, and only use cluster ids that appear in the input. Prefer the bot's own severity markers where the text carries them (⚠️/nitpick/etc.), else judge honestly; distinguish genuinely critical issues (security, correctness, crashes) from nitpicks. Keep titles ≤4 words and summaries to one sentence. If the clusters are overwhelmingly trivial, say so in the narrative.`;

interface RawTheme {
  title?: unknown;
  category?: unknown;
  severity?: unknown;
  summary?: unknown;
  occurrences?: unknown;
  bots?: unknown;
  areas?: unknown;
  examplePrNumbers?: unknown;
  memberIds?: unknown;
}

function coerceCategory(v: unknown): BotThemeCategory {
  return typeof v === 'string' && (CATEGORIES as string[]).includes(v)
    ? (v as BotThemeCategory)
    : 'other';
}
function coerceSeverity(v: unknown): BotThemeSeverity {
  return typeof v === 'string' && (SEVERITIES as string[]).includes(v)
    ? (v as BotThemeSeverity)
    : 'minor';
}
function strArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, cap);
}
function numArray(v: unknown, cap: number): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'number' ? x : Number.parseInt(String(x).replace(/[^0-9]/g, ''), 10)))
    .filter((x): x is number => Number.isFinite(x) && x > 0)
    .slice(0, cap);
}
// Like numArray but keeps 0 — payload item ids (cluster/comment ids) are 0-based.
function idArray(v: unknown, cap: number): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'number' ? Math.trunc(x) : Number.parseInt(String(x).replace(/[^0-9]/g, ''), 10)))
    .filter((x): x is number => Number.isInteger(x) && x >= 0)
    .slice(0, cap);
}

// Index of the '}' that closes the object opened at `from` (string/escape aware); -1 if never closed
// (a truncated object).
function matchObject(s: string, from: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Pull { narrative, themes[] } out of the model text — tolerant of stray fences/prose AND a
// TRUNCATED response (a verbose run can exceed maxTokens mid-JSON). Fast path: the whole object
// parses. Salvage path: recover the narrative + every COMPLETE theme object individually, so a cut
// tail costs only its last theme, never the whole report.
function robustParse(text: string): { narrative: string; themes: RawTheme[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');

  // Fast path — the whole outer object is well-formed.
  if (start >= 0) {
    const end = matchObject(body, start);
    if (end > start) {
      try {
        const obj = JSON.parse(body.slice(start, end + 1)) as {
          narrative?: unknown;
          themes?: unknown;
        };
        return {
          narrative: typeof obj.narrative === 'string' ? obj.narrative : '',
          themes: Array.isArray(obj.themes) ? (obj.themes as RawTheme[]) : [],
        };
      } catch {
        /* fall through to salvage */
      }
    }
  }

  // Salvage — pull the narrative string + each complete theme object out by hand.
  let narrative = '';
  const nm = body.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (nm) {
    try {
      narrative = JSON.parse(`"${nm[1]}"`) as string;
    } catch {
      narrative = nm[1] ?? '';
    }
  }
  const themes: RawTheme[] = [];
  const arrMatch = body.search(/"themes"\s*:\s*\[/);
  let i = arrMatch >= 0 ? body.indexOf('[', arrMatch) + 1 : start >= 0 ? start + 1 : 0;
  while (i < body.length) {
    const objStart = body.indexOf('{', i);
    if (objStart < 0) break;
    const objEnd = matchObject(body, objStart);
    if (objEnd < 0) break; // truncated final object — stop
    try {
      themes.push(JSON.parse(body.slice(objStart, objEnd + 1)) as RawTheme);
    } catch {
      /* skip an unparseable object */
    }
    i = objEnd + 1;
  }
  return { narrative, themes };
}

export interface ParsedThemes {
  narrative: string;
  themes: ParsedTheme[];
  byCategory: BotThemeCategoryCount[];
  bySeverity: BotThemeSeverityCount[];
}

export function parseThemes(text: string): ParsedThemes {
  const { narrative: rawNarrative, themes: rawThemes } = robustParse(text);
  const narrative = rawNarrative.trim();
  const themes: ParsedTheme[] = rawThemes
    .map((t) => {
      const occ = typeof t.occurrences === 'number' ? Math.max(0, Math.round(t.occurrences)) : 0;
      return {
        title: typeof t.title === 'string' && t.title.trim() ? t.title.trim().slice(0, 80) : 'Untitled',
        category: coerceCategory(t.category),
        severity: coerceSeverity(t.severity),
        summary: typeof t.summary === 'string' ? t.summary.trim().slice(0, 280) : '',
        occurrences: occ,
        bots: strArray(t.bots, 6),
        areas: strArray(t.areas, 6),
        examplePrNumbers: numArray(t.examplePrNumbers, 8),
        memberIds: idArray(t.memberIds, 20),
      };
    })
    .filter((t) => t.title !== 'Untitled' || t.summary !== '')
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.occurrences - a.occurrences);

  // byCategory / bySeverity — aggregated from the themes' occurrences (approximate; the deterministic
  // volumes live in build.ts). Only non-zero buckets, largest first.
  const catAcc = new Map<BotThemeCategory, number>();
  const sevAcc = new Map<BotThemeSeverity, number>();
  for (const t of themes) {
    const w = Math.max(t.occurrences, 1);
    catAcc.set(t.category, (catAcc.get(t.category) ?? 0) + w);
    sevAcc.set(t.severity, (sevAcc.get(t.severity) ?? 0) + w);
  }
  const byCategory: BotThemeCategoryCount[] = [...catAcc.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
  const bySeverity: BotThemeSeverityCount[] = SEVERITIES.filter((s) => sevAcc.has(s)).map((s) => ({
    severity: s,
    count: sevAcc.get(s)!,
  }));

  return { narrative, themes, byCategory, bySeverity };
}

// Run the model over a build payload → parsed themes + the usage (for metering).
export async function runThemesLlm(
  llm: LlmClient,
  build: BotThemesBuild,
): Promise<{ parsed: ParsedThemes; costUsd: number; inputTokens: number; outputTokens: number }> {
  const out = await llm.complete({
    system: SYSTEM,
    user: JSON.stringify(build.payload),
    maxTokens: MAX_TOKENS,
  });
  return {
    parsed: parseThemes(out.text),
    costUsd: out.costUsd,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
  };
}
