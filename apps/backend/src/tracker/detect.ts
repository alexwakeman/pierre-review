import type { IssueMatchScope } from '@pierre-review/shared';
import type { DetectInput, DetectedTicket, TrackerConfig } from './types.js';

// TICKET-KEY DETECTION — the LINKING half of the Jira and Linear adapters (both name tickets
// `PREFIX-123`), moved from the plugin's issue-links/extract.ts at apiVersion 23. A provider whose
// keys look different (GitHub's `#123`) brings its own `detect` (./types.ts).
//
// A Jira/Linear ticket key is a project prefix (a letter + 1-9 more alphanumerics), a dash,
// then a run of digits — PROJ-123, ENG-42. The hard part is telling a real key from the sea of
// look-alikes (GPT-4, node-18, v2-0, COVID-19, Q3-2024, HTTP-2). The ONLY structurally reliable
// signal is the workspace's configured project keys (`allowKeys`): when present we emit ONLY keys
// whose prefix is on the list, collapsing false positives to ~zero. Without them we fall back to
// heuristics tuned for precision (the user's complaint is false positives, not misses).
//
// ⚠ THERE ARE EXACTLY TWO PLACES DETECTION EVER LOOKS: THE PR TITLE AND THE HEAD BRANCH NAME.
// COMMIT MESSAGES ARE NOT SCANNED — not here, not anywhere, and never have been. (Recorded because
// "it also needs commit messages" is a natural reading of the two-source behaviour, and because
// commit messages are not even loaded on the lean-storage read path this enricher runs on.)

// The key shape, boundary-hardened for the NO-ALLOWLIST fallback (where precision comes only from
// the regex). Not preceded by an alphanumeric/dot/dash/underscore (so the key isn't the tail of a
// longer token). After the number: reject another alphanumeric/underscore (embedding: `GPT-4o`), a
// `.digit` (decimal: `abc-12.3`), or a `-digit` (version run: `v1-2-3`) — but ALLOW a `-letter`
// slug (`eng-123-fix`) and ordinary punctuation/space (`ENG-123.`, `PROJ-42:`). Prefix (1) +
// number (2) captured; digits capped at 7. Case-insensitive; case is judged per source.
const KEY_RE = /(?<![A-Za-z0-9._-])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})(?![A-Za-z0-9_]|\.\d|-\d)/g;

// The looser shape used ONLY in ALLOWLIST mode. Since the configured prefixes already guarantee
// precision, the boundary just needs to (a) not start mid-token — but a DASH-joined prefix word is
// fine (`fix-ENG-123`, `bugfix-ABC-42`), so the lookbehind drops `-`; and (b) not corrupt the
// NUMBER — reject only a trailing digit (would extend the number) or a `.digit` decimal, while
// ALLOWING `_`- and `-digit`-led slug continuations (`eng-123_fix`, `eng-123-2fa-fix`).
const KEY_RE_ALLOW = /(?<![A-Za-z0-9._])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})(?![0-9]|\.\d)/g;

// Version tags shaped `V<digits>` (V2-0, V1-2) look like keys but never are — dropped in the
// no-allowlist fallback (allowlist mode bypasses this, so a real "V2" project key still resolves).
const VERSION_PREFIX_RE = /^V\d+$/;

// Common "PREFIX-NUMBER" tokens that look like keys but aren't — standards, hashes, CVEs, AI
// models, GPUs, calendar quarters/halves, percentiles. Matched on the UPPERCASED prefix. Used
// ONLY in the no-allowlist fallback (a configured allowlist makes the denylist moot). This list
// is a floor, not the fix — it can never be complete, which is exactly why the allowlist exists.
const NON_TICKET_PREFIXES = new Set([
  // hashing / encoding / crypto
  'UTF', 'UTF8', 'UTF16', 'SHA', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'MD5',
  'CRC', 'CRC32', 'AES', 'RSA', 'BASE64', 'EC',
  // standards / specs / compliance
  'ISO', 'RFC', 'CVE', 'CWE', 'CAPEC', 'WCAG', 'IEEE', 'ANSI', 'ASCII', 'PEP', 'SOC', 'PCI',
  'HIPAA', 'GDPR', 'FIPS', 'NIST',
  // protocols / networking
  'HTTP', 'HTTPS', 'HTTP2', 'IPV', 'IPV4', 'IPV6', 'TLS', 'SSL', 'OAUTH',
  // AI models / hardware
  'GPT', 'GPT3', 'GPT4', 'LLAMA', 'RTX', 'GTX', 'RX', 'X86', 'ARM', 'K8S', 'CUDA',
  // media / misc versioned tokens
  'JPEG', 'MP3', 'MP4', 'H264', 'H265', 'COVID', 'ES', 'ES2015', 'UTC',
  // percentiles / calendar (quarters, halves, fiscal years)
  'P50', 'P90', 'P95', 'P99', 'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'FY',
]);

// Uppercased alpha prefix of a matched key (already the capture group, but normalized).
function normKeys(keys: readonly string[] | null | undefined): Set<string> | null {
  if (!keys || keys.length === 0) return null;
  const s = new Set<string>();
  for (const k of keys) {
    const up = k.trim().toUpperCase();
    if (up !== '') s.add(up);
  }
  return s.size > 0 ? s : null;
}

function collect(
  text: string | null | undefined,
  re: RegExp,
  opts: { requireUpper: boolean; allowKeys: Set<string> | null },
  seen: Set<string>,
  out: string[],
): void {
  if (!text) return;
  for (const m of text.matchAll(re)) {
    const rawPrefix = m[1] as string;
    const num = m[2] as string;
    const prefix = rawPrefix.toUpperCase();
    if (opts.allowKeys != null) {
      // Allowlist mode: precision comes entirely from the configured keys — accept any case,
      // any position, no denylist. A prefix not on the list is dropped.
      if (!opts.allowKeys.has(prefix)) continue;
    } else {
      // Fallback: in prose (the PR title) humans write keys UPPERCASE, so a lowercase prefix
      // is almost always an ordinary word — drop it. Then apply the denylist + version-tag guard.
      if (opts.requireUpper && rawPrefix !== prefix) continue;
      if (NON_TICKET_PREFIXES.has(prefix)) continue;
      if (VERSION_PREFIX_RE.test(prefix)) continue;
    }
    const key = `${prefix}-${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
}

// Detect distinct ticket keys — uppercased, first-seen order, de-duplicated. `allowKeys` (the
// WORKSPACE's configured project prefixes) makes detection exact; without it, precision-tuned
// heuristics apply (uppercase-in-title, denylist, no branch).
//
// `matchScope` is a TRAILING OPTIONAL parameter defaulting to `'title_branch'` — today's
// behaviour — so an unaware caller detects exactly what it always did.
//
// ⚠ `'title'` ONLY BITES IN ALLOWLIST MODE. Without configured prefixes the branch is never
// scanned anyway (see the branch note below), so the two scopes are indistinguishable there. The
// setting exists for the allowlisted case, where a team wants a key to count only when it was
// written into the PR title deliberately.
export function extractTicketKeys(
  title: string | null | undefined,
  headRefName: string | null | undefined,
  allowKeys?: readonly string[] | null,
  matchScope: IssueMatchScope = 'title_branch',
): string[] {
  const allow = normKeys(allowKeys);
  // In allowlist mode the configured prefixes provide precision, so a looser boundary is used —
  // it tolerates dash-joined prefixes + slug continuations that the strict fallback would reject.
  const re = allow != null ? KEY_RE_ALLOW : KEY_RE;
  const seen = new Set<string>();
  const out: string[] = [];
  // Title: uppercase-written keys (fallback) or any allowlisted key.
  collect(title, re, { requireUpper: true, allowKeys: allow }, seen, out);
  // Branch: scanned ONLY when an allowlist gates it AND the workspace's match scope asks for it.
  //
  // The allowlist gate is the PRECISION argument and it is unchanged: a lowercase branch key
  // (eng-123) is structurally indistinguishable from an ordinary `word-number` branch (node-18,
  // fix-2, release-2, a dependency bump like redis-7) — so without the configured prefixes,
  // scanning branches is the single largest false-positive source. With an allowlist it's precise
  // (prefix-gated), so Linear/GitHub prefixed branches (incl. `fix-ENG-123`, `eng-123-2fa`)
  // resolve exactly.
  //
  // The scope gate is a WORKSPACE CHOICE on top of that: a team whose branch names carry a key
  // they do not want linked (a long-lived integration branch, a fork of somebody else's ticket)
  // sets `'title'` and gets title-only detection while KEEPING the allowlist's precision on the
  // title. It cannot loosen anything — it only ever removes a source.
  if (allow != null && matchScope === 'title_branch')
    collect(headRefName, re, { requireUpper: false, allowKeys: allow }, seen, out);
  return out;
}

/**
 * Detection plus WHICH SOURCE named each key — the `detect` of every PREFIX-KEY provider (Jira,
 * Linear). Keys in detection order (title first, then branch); `from` is 'title' when the title
 * names it (a key in both counts as the title's).
 */
export function detectPrefixKeys(
  cfg: Pick<TrackerConfig, 'projectKeys' | 'matchScope'>,
  pr: DetectInput,
): DetectedTicket[] {
  const keys = extractTicketKeys(pr.title, pr.headRefName, cfg.projectKeys, cfg.matchScope);
  const inTitle = new Set(extractTicketKeys(pr.title, null, cfg.projectKeys, cfg.matchScope));
  return keys.map((key, order) => ({ key, from: inTitle.has(key) ? 'title' : 'branch', order }));
}

/** A `PREFIX-123` key as detection emits it. */
export function isPrefixKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(key);
}

/** A key a request carries, as the prefix-key providers store it (upper case), or null. */
export function normalizePrefixKey(raw: string): string | null {
  const k = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(k) ? k : null;
}

// Parse the stored `workspace_trackers.project_keys` column (comma/space/newline-
// separated) into a normalized list: uppercased, only well-shaped prefixes ([A-Z][A-Z0-9]{1,9}),
// de-duplicated, capped. Shared by the settings store (validation) and the enricher (read).
// Returns [] for null/blank.
const PREFIX_SHAPE = /^[A-Z][A-Z0-9]{1,9}$/;
const MAX_PROJECT_KEYS = 40;

export function parseProjectKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,]+/)) {
    const up = tok.trim().toUpperCase();
    if (up === '' || !PREFIX_SHAPE.test(up) || seen.has(up)) continue;
    seen.add(up);
    out.push(up);
    if (out.length >= MAX_PROJECT_KEYS) break;
  }
  return out;
}
