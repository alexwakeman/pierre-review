import { LIMN_RUN_TRAILER_KEY, LEGACY_RUN_TRAILER_KEY } from './limn-actions.js';

// AI VENDOR DETECTION (docs/AI-ADOPTION-REPORT.md § Detection). Which AI coding tools touched a pull
// request, read from the text GitHub sends while it is in hand at sync (commit author, committer and
// message; PR title, description, branch and author). ONE pure detector: the sync walk, the one-time
// backfill and every test call these two functions and nothing else.
//
// ⚠ HIGH PRECISION, NEVER RECALL. A signal is a SPECIFIC marker a tool writes by default: a bot
// login, an agent email, a co-author trailer, an explicit "Generated with X" phrase, a tool's own
// task URL, a tool's default branch prefix. NEVER the bare word "claude", "copilot" or "cursor" in
// prose. An undercount is honest ("declared AI use only"); a false positive is a false claim in a
// document a reader forwards to a board.
//
// ⚠ THE TEXT IS ATTACKER-AUTHORED (anyone can open a PR). Every rule is a substring test, an exact
// table lookup or a LINEAR regex over one capped line. No nested quantifiers, no backtracking over
// the whole body. Inputs are capped before scanning.
//
// ⚠ A CHANGE TO ANY RULE OR TABLE BELOW BUMPS `AI_SIGNALS_VERSION`. The backfill re-scans every PR
// stored under an older version, so a widened vocabulary reaches old PRs too.
//
// Code-review bots (CodeRabbit, Copilot's reviewer, Cursor's Bugbot, Gemini Code Assist) are NOT here:
// they review code, they do not write it. Their figures are the review-bot slide's (getBotAnalytics).
// This vocabulary is SEPARATE from `AUTOMATION_VENDORS` / `REVIEW_BOTS` on purpose: adding a coding
// agent there moves the people-vs-automation split of every period metric.

/** The AI coding tools the report names. Closed and ordered: this order is the render order. */
export type AiCodingVendor =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'devin'
  | 'google'
  | 'amazon'
  | 'windsurf'
  | 'aider'
  | 'factory'
  | 'amp'
  | 'ensemble';

export const AI_CODING_VENDORS: readonly AiCodingVendor[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'google',
  'amazon',
  'windsurf',
  'aider',
  'factory',
  'amp',
  'ensemble',
];

/** The name a reader knows. ⚠ No digits in any label (the commentary's digit gate allows vendor words). */
export const AI_CODING_VENDOR_LABEL: Readonly<Record<AiCodingVendor, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  devin: 'Devin',
  google: 'Gemini / Jules',
  amazon: 'Amazon Q / Kiro',
  windsurf: 'Windsurf',
  aider: 'Aider',
  factory: 'Factory',
  amp: 'Amp',
  ensemble: 'Ensemble',
};

/** Who makes it, for the method slide's vendor table. */
export const AI_CODING_VENDOR_MAKER: Readonly<Record<AiCodingVendor, string>> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  copilot: 'GitHub',
  cursor: 'Anysphere',
  devin: 'Cognition',
  google: 'Google',
  amazon: 'Amazon',
  windsurf: 'Windsurf',
  aider: 'Aider',
  factory: 'Factory',
  amp: 'Amp',
  ensemble: 'Ensemble (AI Fix, Implement story)',
};

/** Where a signal was seen. Closed and ordered (render order). */
export type AiSignalSource =
  | 'commit_author'
  | 'commit_trailer'
  | 'commit_message'
  | 'pr_title'
  | 'pr_body'
  | 'pr_author'
  | 'pr_branch'
  | 'ensemble';

export const AI_SIGNAL_SOURCES: readonly AiSignalSource[] = [
  'commit_author',
  'commit_trailer',
  'commit_message',
  'pr_title',
  'pr_body',
  'pr_author',
  'pr_branch',
  'ensemble',
];

export const AI_SIGNAL_SOURCE_LABEL: Readonly<Record<AiSignalSource, string>> = {
  commit_author: 'Commit author',
  commit_trailer: 'Commit trailer',
  commit_message: 'Commit message',
  pr_title: 'PR title',
  pr_body: 'PR description',
  pr_author: 'PR author',
  pr_branch: 'PR branch name',
  ensemble: "Ensemble's own records",
};

/** One detected involvement. Stored as JSON `[{vendor, source}]` — verdicts only, never text. */
export interface AiSignal {
  vendor: AiCodingVendor;
  source: AiSignalSource;
}

/** The detector's version. Stored beside every scan; the backfill re-scans rows below it. */
export const AI_SIGNALS_VERSION = 2;

/** One commit as GitHub sent it. Absent fields are simply not read. */
export interface AiCommitSignalInput {
  /** The FULL commit message (trailers live in its last paragraph). */
  message?: string | null;
  authorLogin?: string | null;
  authorName?: string | null;
  authorEmail?: string | null;
  committerLogin?: string | null;
  committerName?: string | null;
  committerEmail?: string | null;
}

/** One pull request as GitHub sent it. */
export interface AiPrSignalInput {
  title?: string | null;
  /** GitHub's `bodyText` (plain text; HTML comments and link URLs are gone). */
  bodyText?: string | null;
  /** The markdown `body`, when it was fetched. Both are scanned when both are present. */
  body?: string | null;
  headRefName?: string | null;
  authorLogin?: string | null;
  /** GraphQL `author.__typename`: 'Bot' | 'User' | 'Mannequin' | … */
  authorType?: string | null;
}

// ── The vocabulary ──────────────────────────────────────────────────────────────────────────────

/** Caps: a body or message longer than this is scanned up to the cap only. */
const MAX_TEXT = 64 * 1024;
const MAX_LINE = 400;
const MAX_LINES = 600;

/**
 * Agent ACCOUNTS (lowercase, `[bot]` stripped) → vendor. `botOnly`: the bare login could be a person,
 * so it counts only when GitHub marks it a Bot or the name carries `[bot]`. Every GitHub App account
 * is `botOnly` (GitHub always shows an App as `<slug>[bot]` or types it `Bot`, so a person who
 * registered the bare slug never matches). `Copilot` alone is not: it is GitHub's own reserved
 * account (the coding agent's PR author, typed Bot; the `<id>+Copilot@users.noreply.github.com`
 * co-author of an applied Copilot suggestion).
 *
 * ⚠ `cursor` is the account Cursor's cloud agent opens PRs and pushes commits as (`cursor[bot]`). The
 * same account posts Bugbot REVIEWS, but the detector never reads reviews or comments — only PR and
 * commit authors — so a Bugbot review counts nowhere here.
 */
const AGENT_LOGINS: ReadonlyMap<string, { vendor: AiCodingVendor; botOnly: boolean }> = new Map([
  ['claude', { vendor: 'claude', botOnly: true }],
  ['copilot', { vendor: 'copilot', botOnly: false }],
  ['copilot-swe-agent', { vendor: 'copilot', botOnly: true }],
  ['chatgpt-codex-connector', { vendor: 'codex', botOnly: true }],
  ['cursor', { vendor: 'cursor', botOnly: true }],
  ['devin-ai-integration', { vendor: 'devin', botOnly: true }],
  ['google-labs-jules', { vendor: 'google', botOnly: true }],
  ['amazon-q-developer', { vendor: 'amazon', botOnly: true }],
  ['factory-droid', { vendor: 'factory', botOnly: true }],
]);

/** Agent EMAILS (lowercase, exact) → vendor. */
const AGENT_EMAILS: ReadonlyMap<string, AiCodingVendor> = new Map([
  ['noreply@anthropic.com', 'claude'],
  // Codex CLI's co-author trailer: `Co-authored-by: Codex <noreply@openai.com>`.
  ['noreply@openai.com', 'codex'],
  ['cursoragent@cursor.com', 'cursor'],
  ['noreply@aider.chat', 'aider'],
  ['amp@ampcode.com', 'amp'],
]);

/** Trailer KEYS (case-blind) that only a tool writes: `Key: anything` → vendor. */
const AGENT_TRAILER_KEYS: readonly { key: string; vendor: AiCodingVendor }[] = [
  // Amp's thread link (`Amp-Thread: https://ampcode.com/threads/T-…`; older `Amp-Thread-ID:`).
  { key: 'Amp-Thread', vendor: 'amp' },
  { key: 'Amp-Thread-ID', vendor: 'amp' },
  // Claude Code on the web (`Claude-Session: https://claude.ai/code/session_…`).
  { key: 'Claude-Session', vendor: 'claude' },
];

/** Co-author NAMES (lowercase, exact) that are a tool on their own, whatever the email. */
const AGENT_COAUTHOR_NAMES: ReadonlyMap<string, AiCodingVendor> = new Map([['cursor agent', 'cursor']]);

/**
 * "Generated with X" / "Generated by X" phrases (linear: fixed words, optional brackets), and one
 * tool's own sentence. ⚠ The tool name must be one no person, product or prose word shares: there is
 * NO phrase for Cursor ("generated by cursor position"), Amp ("generated with AMP" pages) or Kiro (a
 * person's name); those tools are read from their accounts, emails and trailers instead.
 *
 * ⚠ A PHRASE COUNTS ONLY AT THE START OF A LINE (a title: at its start), after nothing but
 * decoration (`LINE_DECORATION`: whitespace, an emoji, a list bullet, a heading mark). A tool writes
 * its footer on a line of its own; a person who MENTIONS the footer ("Strip the 'Generated with
 * Claude Code' footer", "commits are generated with Claude Code when …") writes it inside a sentence
 * or inside quote marks, and neither counts. A quoted line (`>`) never counts. Hence each pattern
 * is anchored with `^` and tested on the line with its decoration stripped.
 */
const GENERATED_PHRASES: readonly { re: RegExp; vendor: AiCodingVendor }[] = [
  // Claude Code's default PR / commit footer: "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
  // (`bodyText` drops the link: "🤖 Generated with Claude Code").
  { re: /^generated (?:with|by|using) \[?claude code(?![a-z0-9])/i, vendor: 'claude' },
  { re: /^(?:generated|created) (?:with|by|using) \[?(?:openai )?codex(?![a-z0-9])/i, vendor: 'codex' },
  { re: /^generated (?:with|by|using) \[?(?:github )?copilot(?![a-z0-9])/i, vendor: 'copilot' },
  { re: /^generated (?:with|by|using) \[?windsurf(?![a-z0-9])/i, vendor: 'windsurf' },
  { re: /^generated (?:with|by|using) \[?gemini cli(?![a-z0-9])/i, vendor: 'google' },
  { re: /^generated (?:with|by|using) \[?amazon q(?![a-z0-9])/i, vendor: 'amazon' },
  { re: /^generated (?:with|by|using) \[?aider(?![a-z0-9])/i, vendor: 'aider' },
  // Jules's PR footer: "PR created automatically by Jules for task [123](https://jules.google.com/task/123)".
  { re: /^pr created automatically by jules(?![a-z0-9])/i, vendor: 'google' },
];

/**
 * What may sit before a footer phrase on its line: whitespace, emoji and other symbols, a list bullet
 * (`-`, `*`, `•`), a heading mark, an emphasis mark, an opening bracket. ⚠ NOT quote marks or a
 * backtick — a phrase in quotes or code is a mention — and not a table bar. One character class
 * with `*`, anchored: linear.
 */
const LINE_DECORATION = /^[\s\p{So}\uFE0F\u200D*•·—–#_~(-]*/u;

/**
 * A tool's own task / session URL in a PR description (lowercase host + path). Codex and Devin write
 * theirs as BARE URLs, so `bodyText` keeps them; Jules's sits inside a markdown link, so only the
 * markdown `body` (fetched on PERSIST_BODIES) has it — its footer phrase above covers `bodyText`.
 *
 * ⚠ A URL counts only as the tool writes it (`taskUrlVendors`): with its `https://` scheme, an id
 * after the path, and standing as a line of its own, as a link target `](…)` / `<…>`, or after a
 * short label ending in a colon ("Link to Devin session: …"). A URL in a sentence ("links like
 * chatgpt.com/codex/tasks/ …") or on a quoted line is a mention.
 */
const TASK_URLS: readonly { needle: string; vendor: AiCodingVendor }[] = [
  { needle: 'chatgpt.com/codex/tasks/', vendor: 'codex' },
  { needle: 'app.devin.ai/sessions/', vendor: 'devin' },
  { needle: 'jules.google.com/task/', vendor: 'google' },
  { needle: 'ampcode.com/threads/', vendor: 'amp' },
  { needle: 'claude.ai/code/session_', vendor: 'claude' },
];

/**
 * A tool's DEFAULT branch prefix (lowercase), followed by something. ⚠ No `cursor/`: teams name
 * branches after database and pagination cursors, and Cursor's cloud agent is read from its
 * `cursor[bot]` account and its `Cursor Agent` co-author trailer instead.
 *
 * ⚠ A BRANCH NAME ONLY CORROBORATES. A person may name a branch `claude/…` by hand, so `pr_branch`
 * is recorded only when the SAME vendor is already seen in the PR's author, title or description.
 * It adds a "where seen" row; it never makes a PR count as AI work on its own.
 */
const BRANCH_PREFIXES: readonly { prefix: string; vendor: AiCodingVendor }[] = [
  { prefix: 'codex/', vendor: 'codex' },
  { prefix: 'copilot/', vendor: 'copilot' },
  { prefix: 'devin/', vendor: 'devin' },
  { prefix: 'claude/', vendor: 'claude' },
];

/** Ensemble-Run refs that are AI work. `conflict/`, `auto-merge/`, `deps/`, `update-branch` are not. */
const ENSEMBLE_AI_REFS: readonly string[] = ['ai-fix/', 'story-build/'];

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

const cap = (s: string | null | undefined): string => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : '');

function lines(text: string): string[] {
  const out = text.split('\n', MAX_LINES);
  for (let i = 0; i < out.length; i++) out[i] = out[i]!.slice(0, MAX_LINE).replace(/\r$/, '');
  return out;
}

/** A login or bot name → `{key, isBot}`: lowercased, `[bot]` stripped (and remembered). */
function loginKey(raw: string | null | undefined): { key: string; isBot: boolean } | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (t === '') return null;
  const isBot = t.endsWith('[bot]');
  return { key: isBot ? t.slice(0, -5) : t, isBot };
}

function vendorForLogin(raw: string | null | undefined, typedBot: boolean): AiCodingVendor | null {
  const k = loginKey(raw);
  if (k == null) return null;
  const hit = AGENT_LOGINS.get(k.key);
  if (hit == null) return null;
  if (hit.botOnly && !(k.isBot || typedBot)) return null;
  return hit.vendor;
}

/** `<id>+<login>@users.noreply.github.com` or `<login>@users.noreply.github.com` → the login. */
function noreplyLogin(email: string): string | null {
  const suffix = '@users.noreply.github.com';
  if (!email.endsWith(suffix)) return null;
  const local = email.slice(0, -suffix.length);
  const plus = local.indexOf('+');
  const login = plus >= 0 ? local.slice(plus + 1) : local;
  return login === '' ? null : login;
}

function vendorForEmail(raw: string | null | undefined): AiCodingVendor | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e === '') return null;
  const exact = AGENT_EMAILS.get(e);
  if (exact != null) return exact;
  const login = noreplyLogin(e);
  // A noreply address names a GitHub account; a `[bot]` one is an App account.
  return login == null ? null : vendorForLogin(login, false);
}

/** A git author / committer: login, then email, then the name (`claude[bot]`, `… (aider)`). */
function vendorForIdentity(login: string | null | undefined, name: string | null | undefined, email: string | null | undefined): AiCodingVendor | null {
  const byLogin = vendorForLogin(login, false);
  if (byLogin != null) return byLogin;
  const byEmail = vendorForEmail(email);
  if (byEmail != null) return byEmail;
  if (typeof name === 'string') {
    const n = name.trim().toLowerCase().slice(0, MAX_LINE);
    // Aider's default: the author name gains " (aider)".
    if (n.endsWith(' (aider)')) return 'aider';
    const byName = vendorForName(n);
    if (byName != null) return byName;
  }
  return null;
}

/**
 * A git NAME (author, committer, co-author) → vendor. A name is free text anyone types, so an
 * account name counts only in its App form (`claude[bot]`, `copilot-swe-agent[bot]`), plus the exact
 * tool names in AGENT_COAUTHOR_NAMES. A person whose git name is "Copilot" or "claude" never matches.
 */
function vendorForName(raw: string): AiCodingVendor | null {
  const k = loginKey(raw);
  if (k == null) return null;
  if (k.isBot) {
    const hit = AGENT_LOGINS.get(k.key);
    if (hit != null) return hit.vendor;
  }
  return AGENT_COAUTHOR_NAMES.get(k.key) ?? null;
}

/** `Key: value` on one line, the key matched case-blind. Null when the line is not that trailer. */
function trailerValue(line: string, key: string): string | null {
  if (line.length <= key.length || line.charAt(key.length) !== ':') return null;
  if (line.slice(0, key.length).toLowerCase() !== key.toLowerCase()) return null;
  return line.slice(key.length + 1).trim();
}

/** `Name <email>` → its parts, by index (no regex). */
function splitNameEmail(value: string): { name: string; email: string | null } {
  const lt = value.lastIndexOf('<');
  const gt = value.lastIndexOf('>');
  if (lt >= 0 && gt > lt) return { name: value.slice(0, lt).trim(), email: value.slice(lt + 1, gt).trim() };
  return { name: value.trim(), email: null };
}

/** A quoted line (`> …`), whose words are someone else's. */
const isQuoted = (line: string): boolean => line.trimStart().startsWith('>');

function phraseVendors(text: string, push: (v: AiCodingVendor) => void): void {
  for (const line of lines(text)) {
    if (isQuoted(line)) continue;
    const bare = line.replace(LINE_DECORATION, '');
    for (const p of GENERATED_PHRASES) if (p.re.test(bare)) push(p.vendor);
  }
}

const URL_ID_CHAR = /^[a-z0-9_-]/;
/** A short label before a URL: a few words ending in a colon ("Link to Devin session:"). */
const URL_LABEL = /^[\p{L}\s'-]{1,40}:$/u;

/** Task URLs written the way the tool writes them (see TASK_URLS). Linear: indexOf over one capped line. */
function taskUrlVendors(text: string, push: (v: AiCodingVendor) => void): void {
  for (const raw of lines(text)) {
    if (isQuoted(raw)) continue;
    const line = raw.toLowerCase();
    for (const u of TASK_URLS) {
      let at = line.indexOf(u.needle);
      while (at >= 0) {
        if (taskUrlAt(line, at, u.needle)) {
          push(u.vendor);
          break;
        }
        at = line.indexOf(u.needle, at + u.needle.length);
      }
    }
  }
}

function taskUrlAt(line: string, at: number, needle: string): boolean {
  if (!URL_ID_CHAR.test(line.slice(at + needle.length, at + needle.length + 1))) return false;
  let start = at;
  if (line.slice(start - 4, start) === 'www.') start -= 4;
  if (line.slice(start - 8, start) === 'https://') start -= 8;
  else return false;
  const before = line.slice(0, start);
  if (before.endsWith('](') || before.endsWith('<')) return true;
  const label = before.replace(LINE_DECORATION, '').trimEnd();
  return label === '' || URL_LABEL.test(label);
}

function makeCollector(): { push: (vendor: AiCodingVendor, source: AiSignalSource) => void; list: () => AiSignal[] } {
  const seen = new Set<string>();
  const out: AiSignal[] = [];
  return {
    push(vendor, source) {
      const k = `${vendor}|${source}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ vendor, source });
    },
    list: () => sortAiSignals(out),
  };
}

// ── The detector ────────────────────────────────────────────────────────────────────────────────

/** Signals in ONE commit: its author and committer, its trailers, its message phrases. Pure. */
export function detectAiCommitSignals(input: AiCommitSignalInput): AiSignal[] {
  const c = makeCollector();
  const author = vendorForIdentity(input.authorLogin, input.authorName, input.authorEmail);
  if (author != null) c.push(author, 'commit_author');
  const committer = vendorForIdentity(input.committerLogin, input.committerName, input.committerEmail);
  if (committer != null) c.push(committer, 'commit_author');

  const message = cap(input.message);
  if (message !== '') {
    const ls = lines(message);
    for (const raw of ls) {
      const line = raw.trim();
      const co = trailerValue(line, 'Co-authored-by');
      if (co != null) {
        const { name, email } = splitNameEmail(co);
        const v = vendorForEmail(email) ?? vendorForName(name.slice(0, MAX_LINE));
        if (v != null) c.push(v, 'commit_trailer');
        continue;
      }
      const keyed = AGENT_TRAILER_KEYS.find((t) => trailerValue(line, t.key) != null);
      if (keyed != null) {
        c.push(keyed.vendor, 'commit_trailer');
        continue;
      }
      const run = trailerValue(line, LIMN_RUN_TRAILER_KEY) ?? trailerValue(line, LEGACY_RUN_TRAILER_KEY);
      if (run != null) {
        if (ENSEMBLE_AI_REFS.some((p) => run.startsWith(p))) c.push('ensemble', 'commit_trailer');
        continue;
      }
    }
    // Aider's older default: the subject line starts "aider: ".
    if ((ls[0] ?? '').startsWith('aider: ')) c.push('aider', 'commit_message');
    phraseVendors(message, (v) => c.push(v, 'commit_message'));
  }
  return c.list();
}

/** Signals in ONE pull request's own fields: title, description, branch, author. Pure. */
export function detectAiPrSignals(input: AiPrSignalInput): AiSignal[] {
  const c = makeCollector();
  const typedBot = input.authorType === 'Bot';
  const author = vendorForLogin(input.authorLogin, typedBot);
  if (author != null) c.push(author, 'pr_author');

  const title = cap(input.title).slice(0, MAX_LINE);
  if (title !== '') phraseVendors(title, (v) => c.push(v, 'pr_title'));

  for (const body of [cap(input.bodyText), cap(input.body)]) {
    if (body === '') continue;
    phraseVendors(body, (v) => c.push(v, 'pr_body'));
    taskUrlVendors(body, (v) => c.push(v, 'pr_body'));
  }

  // The branch only corroborates a vendor already seen above (see BRANCH_PREFIXES).
  const branch = typeof input.headRefName === 'string' ? input.headRefName.trim().toLowerCase() : '';
  if (branch !== '') {
    const seen = new Set(c.list().map((s) => s.vendor));
    for (const b of BRANCH_PREFIXES) {
      if (seen.has(b.vendor) && branch.startsWith(b.prefix) && branch.length > b.prefix.length) c.push(b.vendor, 'pr_branch');
    }
  }
  return c.list();
}

/** Canonical order: vendor order, then source order. Pure; returns a new array. */
export function sortAiSignals(list: readonly AiSignal[]): AiSignal[] {
  const vi = (v: AiCodingVendor) => AI_CODING_VENDORS.indexOf(v);
  const si = (s: AiSignalSource) => AI_SIGNAL_SOURCES.indexOf(s);
  return [...list].sort((a, b) => vi(a.vendor) - vi(b.vendor) || si(a.source) - si(b.source));
}

/** Union of several lists, deduped on (vendor, source), canonical order. Pure. */
export function mergeAiSignals(...lists: readonly (readonly AiSignal[] | null | undefined)[]): AiSignal[] {
  const c = makeCollector();
  for (const l of lists) for (const s of l ?? []) c.push(s.vendor, s.source);
  return c.list();
}

const VENDOR_SET: ReadonlySet<string> = new Set(AI_CODING_VENDORS);
const SOURCE_SET: ReadonlySet<string> = new Set(AI_SIGNAL_SOURCES);

/**
 * A stored `ai_signals` JSON column → the signals. NULL (never scanned) → null; `[]` → []. Unknown
 * vendors / sources (a newer writer) and malformed JSON are dropped, never thrown.
 */
export function parseStoredAiSignals(json: string | null | undefined): AiSignal[] | null {
  if (json == null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: AiSignal[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const { vendor, source } = r as Record<string, unknown>;
    if (typeof vendor === 'string' && typeof source === 'string' && VENDOR_SET.has(vendor) && SOURCE_SET.has(source)) {
      out.push({ vendor: vendor as AiCodingVendor, source: source as AiSignalSource });
    }
  }
  return mergeAiSignals(out);
}

/** The signals as the column stores them. */
export function serializeAiSignals(list: readonly AiSignal[]): string {
  return JSON.stringify(sortAiSignals(list).map((s) => ({ vendor: s.vendor, source: s.source })));
}

/** The distinct vendors in a list, in vendor order. */
export function aiVendorsOf(list: readonly AiSignal[]): AiCodingVendor[] {
  const set = new Set(list.map((s) => s.vendor));
  return AI_CODING_VENDORS.filter((v) => set.has(v));
}
