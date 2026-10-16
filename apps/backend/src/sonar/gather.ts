import {
  SONARCLOUD_HOST,
  SONAR_ISSUE_CAP,
  SONAR_SEVERITY_ORDER,
  type SonarCodeLine,
  type SonarIssue,
  type SonarQualityGate,
  type SonarSeverity,
  type SonarSnapshotState,
} from '@pierre-review/shared';
import { SonarError, sonarErrorMessage, type SonarClient } from './client.js';

// READING ONE PULL REQUEST'S SONARCLOUD ANALYSIS (docs/SONARCLOUD.md § What is read). Everything an
// automated fix needs, in this order:
//   1. the quality gate for the PR      api/qualitygates/project_status?projectKey&pullRequest
//      (a 404 here is told apart by    api/components/show — no project vs no analysis yet)
//   2. the open issues on the PR        api/issues/search?componentKeys&pullRequest&resolved=false
//                                       &additionalFields=_all (≤ ISSUE_PAGES pages of 500)
//   3. the security hotspots to review  api/hotspots/search?projectKey&pullRequest&status=TO_REVIEW
//   4. RANK both together (severity, issues before hotspots, then file and line) and CAP at
//      SONAR_ISSUE_CAP. The totals SonarCloud reported travel with the list, so every screen can
//      say "50 of 132" — nothing is cut silently.
//   5. for the KEPT items only: each distinct rule's description (api/rules/show, cached per
//      account + organization + rule for RULE_TTL_MS) and the flagged lines with a little context
//      (api/sources/lines). Both are ENRICHMENTS: a failure, or the overall deadline, costs that
//      item its guidance or its code — never the snapshot.
//
// Every SonarCloud failure becomes a NAMED state (`SonarSnapshotState`) with a sentence we wrote.
// Nothing here throws to its caller.

const ISSUE_PAGE_SIZE = 500;
const ISSUE_PAGES = 2;
const HOTSPOT_PAGE_SIZE = 500;
/** Lines of context either side of an issue's text range, and the most lines kept per issue. */
const CONTEXT_LINES = 2;
const MAX_CODE_LINES = 14;
const CODE_LINE_CHARS = 300;
const MESSAGE_CHARS = 600;
const HOW_TO_FIX_CHARS = 2_000;
const WHY_CHARS = 900;
/** Enrichment calls in flight at once. */
const CONCURRENCY = 4;
/** The whole gather's time budget; enrichments stop when it is spent. */
export const SONAR_GATHER_DEADLINE_MS = 60_000;
export const RULE_TTL_MS = 24 * 60 * 60 * 1000;
const RULE_CACHE_MAX = 2_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SonarGatherInput {
  accountId: number;
  organization: string;
  projectKey: string;
  prNumber: number;
  /** Absolute ms; defaults to now + SONAR_GATHER_DEADLINE_MS. */
  deadline?: number;
  now?: () => number;
}

export interface SonarGatherResult {
  state: SonarSnapshotState;
  message: string | null;
  qualityGate: SonarQualityGate | null;
  issues: SonarIssue[];
  totalIssues: number;
  totalHotspots: number;
}

// ---- pure ----

const LEGACY_SEVERITY: Record<string, SonarSeverity> = {
  BLOCKER: 'blocker',
  CRITICAL: 'critical',
  MAJOR: 'major',
  MINOR: 'minor',
  INFO: 'info',
};
// The "clean code" impact scale (newer SonarCloud): BLOCKER > HIGH > MEDIUM > LOW > INFO.
const IMPACT_SEVERITY: Record<string, SonarSeverity> = {
  BLOCKER: 'blocker',
  HIGH: 'critical',
  MEDIUM: 'major',
  LOW: 'minor',
  INFO: 'info',
};
const rank = (s: SonarSeverity): number => SONAR_SEVERITY_ORDER.indexOf(s);

/** An issue's severity: the legacy field, else the highest impact; 'major' when neither is given. */
export function issueSeverity(raw: { severity?: unknown; impacts?: unknown }): SonarSeverity {
  const legacy = typeof raw.severity === 'string' ? LEGACY_SEVERITY[raw.severity.toUpperCase()] : undefined;
  if (legacy) return legacy;
  let best: SonarSeverity | null = null;
  for (const imp of Array.isArray(raw.impacts) ? raw.impacts : []) {
    const s = typeof imp?.severity === 'string' ? IMPACT_SEVERITY[imp.severity.toUpperCase()] : undefined;
    if (s && (best == null || rank(s) < rank(best))) best = s;
  }
  return best ?? 'major';
}

/** A hotspot's review priority on the issue scale. */
export function hotspotSeverity(probability: unknown): SonarSeverity {
  const p = typeof probability === 'string' ? probability.toUpperCase() : '';
  return p === 'HIGH' ? 'critical' : p === 'MEDIUM' ? 'major' : 'minor';
}

/**
 * Severity first (blocker → info), an issue before a hotspot of the same severity, then file and
 * line so the order is stable. Pure; does not cap.
 */
export function rankSonarItems(items: readonly SonarIssue[]): SonarIssue[] {
  return items
    .map((it, idx) => ({ it, idx }))
    .sort(
      (a, b) =>
        rank(a.it.severity) - rank(b.it.severity) ||
        (a.it.kind === b.it.kind ? 0 : a.it.kind === 'issue' ? -1 : 1) ||
        (a.it.path ?? '').localeCompare(b.it.path ?? '') ||
        (a.it.line ?? 0) - (b.it.line ?? 0) ||
        a.idx - b.idx,
    )
    .map((x) => x.it);
}

/** Rank and keep the first `cap`. */
export function capSonarItems(items: readonly SonarIssue[], cap = SONAR_ISSUE_CAP): SonarIssue[] {
  return rankSonarItems(items).slice(0, cap);
}

/** "50 of 132 issues" — the cut, stated. Shared by the comment and the prompt. */
export function sonarCutSentence(shown: number, totalIssues: number, totalHotspots: number): string {
  const total = totalIssues + totalHotspots;
  const noun = total === 1 ? 'issue' : 'issues';
  return shown >= total ? `${total} ${noun}` : `${shown} of ${total} ${noun}, highest severity first`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower]!;
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16) || 32);
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10) || 32);
    return m;
  });
}

/** SonarCloud's rule HTML → plain text with line breaks and list dashes. */
export function htmlToText(html: string): string {
  const s = html
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|pre|table|tr)\s*>/gi, '\n')
    .replace(/<\s*(p|div|h[1-6]|ul|ol|pre|table|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** A rule's "why" and "how to fix", from its description sections (or the legacy one-piece text). */
export function ruleGuidance(rule: Json): { name: string | null; why: string | null; howToFix: string | null } {
  const name = typeof rule?.name === 'string' ? rule.name : null;
  const sections: Json[] = Array.isArray(rule?.descriptionSections) ? rule.descriptionSections : [];
  const byKey = (k: string): string | null => {
    const parts = sections
      .filter((s) => s?.key === k && typeof s?.content === 'string')
      .map((s) => htmlToText(s.content))
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n') : null;
  };
  let why = byKey('root_cause') ?? byKey('introduction') ?? byKey('assess_the_problem');
  let howToFix = byKey('how_to_fix');
  if (why == null && howToFix == null) {
    const legacy = typeof rule?.htmlDesc === 'string' ? rule.htmlDesc : typeof rule?.mdDesc === 'string' ? rule.mdDesc : '';
    const text = legacy ? htmlToText(legacy) : '';
    // The one-piece description usually carries the fix as a "Compliant solution" example.
    const at = text.search(/compliant solution|how to fix|recommended secure coding practices/i);
    if (at > 0) {
      why = text.slice(0, at).trim() || null;
      howToFix = text.slice(at).trim() || null;
    } else if (text) {
      why = text;
    }
  }
  return {
    name,
    why: why ? clip(why, WHY_CHARS) : null,
    howToFix: howToFix ? clip(howToFix, HOW_TO_FIX_CHARS) : null,
  };
}

/** `projectKey:src/a.ts` → `src/a.ts`; the project itself → null. */
export function componentPath(component: unknown, projectKey: string): string | null {
  if (typeof component !== 'string' || component === '' || component === projectKey) return null;
  const prefix = `${projectKey}:`;
  return component.startsWith(prefix) ? component.slice(prefix.length) || null : component.replace(/^[^:]*:/, '') || null;
}

const issueUrl = (pk: string, pr: number, key: string): string =>
  `${SONARCLOUD_HOST}/project/issues?id=${encodeURIComponent(pk)}&pullRequest=${pr}&open=${encodeURIComponent(key)}`;
const hotspotUrl = (pk: string, pr: number, key: string): string =>
  `${SONARCLOUD_HOST}/project/security_hotspots?id=${encodeURIComponent(pk)}&pullRequest=${pr}&hotspots=${encodeURIComponent(key)}`;
export const sonarDashboardUrl = (pk: string, pr: number): string =>
  `${SONARCLOUD_HOST}/summary/new_code?id=${encodeURIComponent(pk)}&pullRequest=${pr}`;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One `issues/search` issue → our shape (no guidance, no code yet). */
export function parseIssue(raw: Json, projectKey: string, prNumber: number, ruleNames: Map<string, string>): SonarIssue | null {
  const key = str(raw?.key);
  const rule = str(raw?.rule);
  if (!key || !rule) return null;
  const start = num(raw?.textRange?.startLine) ?? num(raw?.line);
  const end = num(raw?.textRange?.endLine) ?? start;
  return {
    key,
    kind: 'issue',
    rule,
    ruleName: ruleNames.get(rule) ?? null,
    severity: issueSeverity(raw),
    type: str(raw?.type),
    message: clip(str(raw?.message) ?? '', MESSAGE_CHARS),
    path: componentPath(raw?.component, projectKey),
    line: start,
    endLine: end,
    effort: str(raw?.effort) ?? str(raw?.debt),
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((t: unknown): t is string => typeof t === 'string').slice(0, 10) : [],
    securityCategory: null,
    whyIsThisAnIssue: null,
    howToFix: null,
    code: [],
    url: issueUrl(projectKey, prNumber, key),
  };
}

/** One `hotspots/search` hotspot → our shape. */
export function parseHotspot(raw: Json, projectKey: string, prNumber: number): SonarIssue | null {
  const key = str(raw?.key);
  const rule = str(raw?.ruleKey) ?? str(raw?.rule?.key);
  if (!key || !rule) return null;
  const start = num(raw?.textRange?.startLine) ?? num(raw?.line);
  const end = num(raw?.textRange?.endLine) ?? start;
  return {
    key,
    kind: 'hotspot',
    rule,
    ruleName: str(raw?.rule?.name),
    severity: hotspotSeverity(raw?.vulnerabilityProbability),
    type: 'SECURITY_HOTSPOT',
    message: clip(str(raw?.message) ?? '', MESSAGE_CHARS),
    path: componentPath(raw?.component, projectKey),
    line: start,
    endLine: end,
    effort: null,
    tags: [],
    securityCategory: str(raw?.securityCategory),
    whyIsThisAnIssue: null,
    howToFix: null,
    code: [],
    url: hotspotUrl(projectKey, prNumber, key),
  };
}

export function parseGate(raw: Json): SonarQualityGate | null {
  const ps = raw?.projectStatus;
  if (!ps || typeof ps.status !== 'string') return null;
  const status = ['OK', 'WARN', 'ERROR', 'NONE'].includes(ps.status) ? ps.status : 'NONE';
  const conditions = (Array.isArray(ps.conditions) ? ps.conditions : []).slice(0, 30).map((c: Json) => ({
    metric: str(c?.metricKey) ?? 'unknown',
    status: str(c?.status) ?? 'NONE',
    actual: str(c?.actualValue),
    threshold: str(c?.errorThreshold) ?? str(c?.warningThreshold),
    comparator: str(c?.comparator),
  }));
  return { status, conditions };
}

/** Lines `sources/lines` returned → the issue's window, as plain text. */
export function codeWindow(
  sources: Json,
  start: number,
  end: number,
): SonarCodeLine[] {
  const rows: Json[] = Array.isArray(sources?.sources) ? sources.sources : [];
  return rows
    .filter((r) => typeof r?.line === 'number' && typeof r?.code === 'string')
    .map((r) => ({
      line: r.line as number,
      code: clip(decodeEntities(String(r.code).replace(/<[^>]+>/g, '')), CODE_LINE_CHARS),
      flagged: r.line >= start && r.line <= end,
    }))
    .slice(0, MAX_CODE_LINES);
}

// ---- the rule cache (per account + organization + rule key) ----

interface CachedRule {
  at: number;
  value: { name: string | null; why: string | null; howToFix: string | null } | null;
}
const ruleCache = new Map<string, CachedRule>();

/** Test seam. */
export function _clearSonarRuleCache(): void {
  ruleCache.clear();
}
export function _sonarRuleCacheSize(): number {
  return ruleCache.size;
}

/** One rule's guidance — cached; a failure caches nothing and answers null. */
export async function fetchRuleGuidance(
  client: SonarClient,
  accountId: number,
  organization: string,
  ruleKey: string,
  now: () => number = Date.now,
): Promise<CachedRule['value']> {
  const ck = `${accountId}\u0000${organization}\u0000${ruleKey}`;
  const hit = ruleCache.get(ck);
  if (hit && now() - hit.at < RULE_TTL_MS) return hit.value;
  try {
    const res = (await client.get('api/rules/show', { key: ruleKey, organization })) as Json;
    const value = ruleGuidance(res?.rule);
    if (ruleCache.size >= RULE_CACHE_MAX) {
      const oldest = ruleCache.keys().next().value;
      if (oldest !== undefined) ruleCache.delete(oldest);
    }
    ruleCache.set(ck, { at: now(), value });
    return value;
  } catch {
    return null;
  }
}

async function pool<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const it = items[i++]!;
      await fn(it);
    }
  });
  await Promise.all(workers);
}

const stateOf = (err: unknown): { state: SonarSnapshotState; message: string } => {
  const code = err instanceof SonarError ? err.code : 'network';
  if (code === 'unauthorized' || code === 'forbidden') return { state: 'unauthorized', message: sonarErrorMessage(err) };
  return { state: 'error', message: sonarErrorMessage(err) };
};

const empty = (state: SonarSnapshotState, message: string | null): SonarGatherResult => ({
  state,
  message,
  qualityGate: null,
  issues: [],
  totalIssues: 0,
  totalHotspots: 0,
});

/** Read one PR's analysis. Never throws. */
export async function gatherSonarForPr(client: SonarClient, input: SonarGatherInput): Promise<SonarGatherResult> {
  const now = input.now ?? Date.now;
  const deadline = input.deadline ?? now() + SONAR_GATHER_DEADLINE_MS;
  const { organization, projectKey, prNumber } = input;
  const pr = String(prNumber);

  // 1. The quality gate — also the "is there an analysis at all?" probe.
  let qualityGate: SonarQualityGate | null = null;
  try {
    qualityGate = parseGate(await client.get('api/qualitygates/project_status', { projectKey, pullRequest: pr, organization }));
  } catch (err) {
    if (err instanceof SonarError && err.code === 'not_found') {
      try {
        await client.get('api/components/show', { component: projectKey, organization });
        return empty('not_analyzed', 'SonarCloud has not analysed this pull request yet.');
      } catch (inner) {
        if (inner instanceof SonarError && inner.code === 'not_found') {
          return empty('no_project', `SonarCloud has no project “${projectKey}”. Check the project key in Settings.`);
        }
        const s = stateOf(inner);
        return empty(s.state, s.message);
      }
    }
    const s = stateOf(err);
    return empty(s.state, s.message);
  }

  // 2. Issues.
  const parsed: SonarIssue[] = [];
  let totalIssues = 0;
  try {
    for (let p = 1; p <= ISSUE_PAGES; p += 1) {
      const res = (await client.get('api/issues/search', {
        componentKeys: projectKey,
        organization,
        pullRequest: pr,
        resolved: 'false',
        additionalFields: '_all',
        s: 'SEVERITY',
        asc: 'false',
        ps: ISSUE_PAGE_SIZE,
        p,
      })) as Json;
      const names = new Map<string, string>();
      for (const r of Array.isArray(res?.rules) ? res.rules : []) {
        if (typeof r?.key === 'string' && typeof r?.name === 'string') names.set(r.key, r.name);
      }
      const list: Json[] = Array.isArray(res?.issues) ? res.issues : [];
      for (const raw of list) {
        const it = parseIssue(raw, projectKey, prNumber, names);
        if (it) parsed.push(it);
      }
      totalIssues = num(res?.paging?.total) ?? num(res?.total) ?? parsed.length;
      if (list.length < ISSUE_PAGE_SIZE || parsed.length >= totalIssues) break;
    }
  } catch (err) {
    const s = stateOf(err);
    return { ...empty(s.state, s.message), qualityGate };
  }

  // 3. Hotspots — a failure here costs the hotspots only (some tokens may not browse them).
  let totalHotspots = 0;
  try {
    const res = (await client.get('api/hotspots/search', {
      projectKey,
      pullRequest: pr,
      status: 'TO_REVIEW',
      ps: HOTSPOT_PAGE_SIZE,
      p: 1,
    })) as Json;
    const list: Json[] = Array.isArray(res?.hotspots) ? res.hotspots : [];
    for (const raw of list) {
      const it = parseHotspot(raw, projectKey, prNumber);
      if (it) parsed.push(it);
    }
    totalHotspots = num(res?.paging?.total) ?? list.length;
  } catch {
    totalHotspots = 0;
  }

  // 4. Rank + cap. The totals never shrink below what was actually received.
  totalIssues = Math.max(totalIssues, parsed.filter((i) => i.kind === 'issue').length);
  totalHotspots = Math.max(totalHotspots, parsed.filter((i) => i.kind === 'hotspot').length);
  const kept = capSonarItems(parsed);

  // 5. Enrichments, inside the deadline.
  const rules = [...new Set(kept.map((i) => i.rule))];
  const guidance = new Map<string, CachedRule['value']>();
  await pool(rules, CONCURRENCY, async (rk) => {
    if (now() >= deadline) return;
    guidance.set(rk, await fetchRuleGuidance(client, input.accountId, organization, rk, now));
  });
  for (const it of kept) {
    const g = guidance.get(it.rule);
    if (!g) continue;
    it.ruleName = it.ruleName ?? g.name;
    it.whyIsThisAnIssue = g.why;
    it.howToFix = g.howToFix;
  }
  await pool(
    kept.filter((i) => i.path != null && i.line != null),
    CONCURRENCY,
    async (it) => {
      if (now() >= deadline) return;
      const start = it.line!;
      const end = Math.max(start, it.endLine ?? start);
      const from = Math.max(1, start - CONTEXT_LINES);
      const to = Math.min(end + CONTEXT_LINES, from + MAX_CODE_LINES - 1);
      try {
        const res = await client.get('api/sources/lines', {
          key: `${projectKey}:${it.path}`,
          pullRequest: pr,
          from,
          to,
        });
        it.code = codeWindow(res, start, end);
      } catch {
        it.code = [];
      }
    },
  );

  return { state: 'ok', message: null, qualityGate, issues: kept, totalIssues, totalHotspots };
}
