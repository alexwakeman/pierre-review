// The synthesis SCOPE: wire params → a canonical `SynthesisScope` descriptor → the ONE serialised
// `scope_key` (the cache row's identity, and the client's shared mutation-key segment).
//
// TWO RULES DO ALL THE WORK HERE:
//
//  1. CANONICALISE BEFORE KEYING. `canonicalSynthesisScope` fills defaults (`select` →
//     'findings') and DROPS every field the kind does not consume (a volume scope carries no
//     `category`; the windowless 'bot-threads' backlog carries no window at all). Without this,
//     two spellings of one drill-down — `select` omitted vs `select=findings`, a stray direction
//     on a threads scope — would mint two cache rows for one population and bill twice.
//
//  2. VALIDATION SPLITS BY WHO MINTED THE VALUE (the core route's rule, host bot-triage.ts):
//     `workspace`/`repoIds` can be a stale bookmark and DEGRADE (Default workspace / membership
//     intersection — the caller resolves them before this module sees them); everything else
//     names a POPULATION and is written by the surface that opened the card, so an unknown
//     `kind`, a bad `severities` list or a garbage `direction` REJECTS (→ the route 400s) rather
//     than silently summarising a different set than the list beside it.
import type {
  BotWindowKind,
  MlCategory,
  MlSeverity,
  SynthesisFlaggingSelect,
  SynthesisScope,
  SynthesisScopeKind,
  VendorDisagreeDirection,
} from '@pierre-review/shared';
import { scopeKeyFor } from '../insights/workspace-scope.js';

// Local value copies of the shared unions (the FLAGGING_CATEGORY_VALUES accommodation:
// `@pierre-review/shared` is types-only, so the backend/plugin cannot import value arrays from
// it). The `SynthesisScopeKind[]`-style annotations are load-bearing — a member the union drops
// stops compiling here.
const SCOPE_KINDS: SynthesisScopeKind[] = [
  'bot-flagging',
  'bot-threads',
  'bot-volume',
  'workspace-bots',
];
// (REMOVED 2026-10-22: the 'person' and 'person_report' kinds — the 1:1 prep narration and the
// People report's sections. Their stored `pro_synthesis` rows are DORMANT; their keys carried a
// `u:`/`pw:` tail, so no live kind's key can collide with one.)

/** The windowless kind: 'bot-threads' (a current-state backlog). Its enum-window key slot is
 *  normalised to '-' (a window there would mint spurious cache rows). */
const WINDOWLESS_KINDS = new Set<SynthesisScopeKind>(['bot-threads']);

const WINDOWS: BotWindowKind[] = ['rolling_7', 'rolling_14', 'rolling_30', 'rolling_90', 'sprint'];
const SELECTS: SynthesisFlaggingSelect[] = ['findings', 'summaries', 'severity', 'category'];
const DIRECTIONS: VendorDisagreeDirection[] = ['any', 'over', 'under'];
const SEVERITIES: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];
const CATEGORIES: MlCategory[] = [
  'correctness_bug',
  'security',
  'performance',
  'style_readability',
  'maintainability_refactor',
  'testing',
  'documentation',
  'nitpick',
  'praise',
];

/** The raw wire params (query string or POST body — both are strings on the wire). */
export interface SynthesisWireParams {
  kind?: string;
  window?: string;
  botUserId?: string;
  direction?: string;
  select?: string;
  severities?: string; // CSV
  category?: string;
}

/** Everything of the descriptor EXCEPT the resolver-produced workspace/repo halves. */
export type SynthesisScopeParams = Omit<SynthesisScope, 'workspaceId' | 'repoIds'>;

export type SynthesisParseResult =
  | { ok: true; params: SynthesisScopeParams }
  | { ok: false; error: string };

function oneOf<T extends string>(raw: string | undefined, valid: readonly T[]): T | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  return (valid as readonly string[]).includes(raw.trim()) ? (raw.trim() as T) : undefined;
}

/** Wire → validated + CANONICAL scope params, or a 400-able error. */
export function parseSynthesisParams(q: SynthesisWireParams): SynthesisParseResult {
  const kind = oneOf(q.kind, SCOPE_KINDS);
  if (!kind) {
    return { ok: false, error: `\`kind\` must be one of ${SCOPE_KINDS.join(', ')}` };
  }
  // Window degrades to the family default rather than 400ing — like every window enum on the bot
  // surface, an unknown value is more likely a stale bookmark than a population claim.
  const window = oneOf(q.window, WINDOWS) ?? 'rolling_14';

  let botUserId: number | undefined;
  if (q.botUserId != null && q.botUserId.trim() !== '') {
    const n = Number.parseInt(q.botUserId.trim(), 10);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: '`botUserId` must be a positive integer' };
    }
    botUserId = n;
  }

  const direction = q.direction == null || q.direction === '' ? undefined : oneOf(q.direction, DIRECTIONS);
  if (q.direction != null && q.direction !== '' && direction === undefined) {
    return { ok: false, error: `\`direction\` must be one of ${DIRECTIONS.join(', ')}` };
  }

  const select = q.select == null || q.select === '' ? undefined : oneOf(q.select, SELECTS);
  if (q.select != null && q.select !== '' && select === undefined) {
    return { ok: false, error: `\`select\` must be one of ${SELECTS.join(', ')}` };
  }

  // ⚠ AN UNKNOWN OR EMPTY SEVERITY LIST 400s (the flagging route's own rule): the list is written
  // by the tile that opened the card, and silently dropping an unrecognised class would name a
  // DIFFERENT population than the tile did.
  let severities: MlSeverity[] | undefined;
  if (q.severities != null && q.severities.trim() !== '') {
    const raw = q.severities
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const parsed = raw.filter((s): s is MlSeverity => (SEVERITIES as string[]).includes(s));
    if (parsed.length === 0 || parsed.length !== raw.length) {
      return {
        ok: false,
        error: `\`severities\` must be a comma-separated subset of ${SEVERITIES.join(', ')}`,
      };
    }
    severities = parsed;
  }

  const category = q.category == null || q.category === '' ? undefined : oneOf(q.category, CATEGORIES);
  if (q.category != null && q.category !== '' && category === undefined) {
    return { ok: false, error: '`category` is not a known ML category' };
  }

  return {
    ok: true,
    params: canonicalSynthesisParams({
      kind,
      window,
      botUserId,
      direction,
      select,
      severities,
      category,
    }),
  };
}

/**
 * Canonicalise: fill kind-relevant defaults, DROP kind-irrelevant fields, sort the severity list.
 * Applied before both the core fold call and the scope key, so the two can never disagree about
 * what the descriptor "really" was.
 */
export function canonicalSynthesisParams(p: SynthesisScopeParams): SynthesisScopeParams {
  const flagging = p.kind === 'bot-flagging';
  const select = flagging ? (p.select ?? 'findings') : undefined;
  return {
    kind: p.kind,
    // The windowless kind ('bot-threads') keeps the family default in this
    // slot; the KEY builder below renders it '-' so two windows cannot mint two cache rows.
    window: p.window,
    botUserId: flagging || p.kind === 'bot-volume' ? p.botUserId : undefined,
    direction: flagging ? p.direction : undefined,
    select,
    severities:
      flagging && select === 'severity' && p.severities
        ? [...p.severities].sort()
        : undefined,
    category: flagging && select === 'category' ? p.category : undefined,
  };
}

/** A canonical params set that still cannot name a population (the core fold would throw). */
export function synthesisParamsError(p: SynthesisScopeParams): string | null {
  if (p.kind !== 'bot-flagging') return null;
  if (p.select === 'severity' && (!p.severities || p.severities.length === 0)) {
    return '`select=severity` requires `severities`';
  }
  if (p.select === 'category' && !p.category) {
    return '`select=category` requires `category`';
  }
  return null;
}

/**
 * THE scope key — the `pro_synthesis` row's identity under UNIQUE (account_id, scope_key), and
 * the segments the SPA's shared mutation key mirrors. Fixed slot order, absent slots as '-', so
 * the arity never varies and no field can be confused for its neighbour.
 *
 * `narrow` is the caller's repo NARROWING as given (sorted + deduped), '-' when absent — NOT the
 * resolved membership: keying on the intersection would re-mint the row whenever workspace
 * membership drifts, while the un-narrowed common case stays stable. Correctness never rests on
 * the key alone — the payload hash folds the actual input ids.
 *
 * `syn1|` versions the key vocabulary itself (the `ws:` prefix lesson: an unversioned key that
 * changes meaning serves a stale cached answer for the wrong population).
 */
export function synthesisScopeKey(
  workspaceId: number,
  p: SynthesisScopeParams,
  narrow: number[] | null,
): string {
  return [
    'syn1',
    `k:${p.kind}`,
    scopeKeyFor(workspaceId),
    `w:${WINDOWLESS_KINDS.has(p.kind) ? '-' : p.window}`,
    `r:${narrow == null ? '-' : [...new Set(narrow)].sort((a, b) => a - b).join(',')}`,
    `b:${p.botUserId ?? '-'}`,
    `d:${p.direction ?? '-'}`,
    `s:${p.select ?? '-'}`,
    `v:${p.severities?.join(',') ?? '-'}`,
    `c:${p.category ?? '-'}`,
  ].join('|');
}
