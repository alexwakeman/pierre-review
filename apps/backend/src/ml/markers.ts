// Per-vendor marker → common-schema extractors: a byte-for-byte port of the severity service's
// `bot_monitor/parse/markers.py` (packages/ml), so bot-comment scoring can run inside this
// process (docs/ML-NODE-PORT.md, Phase 1).
//
// What it produces, per comment: the vendor's OWN declared severity (shown beside ours), whether
// the comment is a summary rather than a finding, the marker categories (v1's category source),
// and `stripVendorChrome` — the text the severity model was TRAINED on. That last one is the
// train/serve parity point: a chrome-stripping difference here moves the model's answer without
// any model change.
//
// ⚠ PARITY IS PINNED BY FIXTURES, NOT BY READING. `markers.test.ts` replays the ~1,000 comments
// `packages/ml/scripts/export_parity_fixtures.py` recorded and requires every field to match the
// Python exactly. Change the Python and this file together, then re-export.
//
// ⚠ PYTHON AND JS REGEXES DISAGREE, so every pattern is written in its PYTHON source and compiled
// through `pyRe`, which gives the Python meanings back:
//   - `\s` is Python's whitespace (includes \x1c-\x1f and \x85, excludes U+FEFF);
//   - `\w`, `\b` are UNICODE word characters — JS keeps them ASCII even with the `u` flag;
//   - `\d` is any Unicode decimal digit;
//   - `.` excludes only `\n` (JS also excludes \r, U+2028, U+2029);
//   - `^`/`$` under MULTILINE break at `\n` only — JS's `m` also breaks at `\r`, so a CRLF body
//     would anchor differently.
// The pattern SOURCE strings are kept verbatim because `matched` records them, exactly as Python's
// `pat.pattern` does.

export type Kind =
  | 'coderabbit'
  | 'greptile'
  | 'copilot'
  | 'qodo'
  | 'sourcery'
  | 'bito'
  | 'ellipsis'
  | 'korbit'
  | 'baz'
  | 'graphite'
  | 'cursor'
  | 'devin'
  | 'entelligence'
  | 'codeant'
  | 'in_house'
  | 'unknown'
  | 'codex'
  | 'deepsource';

const KINDS: ReadonlySet<string> = new Set<Kind>([
  'coderabbit',
  'greptile',
  'copilot',
  'qodo',
  'sourcery',
  'bito',
  'ellipsis',
  'korbit',
  'baz',
  'graphite',
  'cursor',
  'devin',
  'entelligence',
  'codeant',
  'in_house',
  'unknown',
  'codex',
  'deepsource',
]);

export type Severity = 'NIT' | 'MINOR' | 'MAJOR' | 'CRITICAL';
export const SEVERITY_ORD: Readonly<Record<Severity, number>> = {
  NIT: 0,
  MINOR: 1,
  MAJOR: 2,
  CRITICAL: 3,
};
const SEVERITY_BY_ORD: readonly Severity[] = ['NIT', 'MINOR', 'MAJOR', 'CRITICAL'];

function escalate(sev: Severity, levels = 1): Severity {
  return SEVERITY_BY_ORD[Math.max(0, Math.min(3, SEVERITY_ORD[sev] + levels))]!;
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORD[a] >= SEVERITY_ORD[b] ? a : b;
}

export type Category =
  | 'correctness_bug'
  | 'security'
  | 'performance'
  | 'style_readability'
  | 'maintainability_refactor'
  | 'testing'
  | 'documentation'
  | 'nitpick'
  | 'praise';

/** Python's CATEGORY_ORDER — the order every category list is emitted in. */
export const CATEGORY_ORDER: readonly Category[] = [
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

export type MarkerConfidence = 'high' | 'medium' | 'low';
export const MARKER_CONFIDENCE_SCORE: Readonly<Record<MarkerConfidence, number>> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

export interface MarkerResult {
  vendor: Kind;
  /** The weak LABEL: the badge, then our escalation / praise / keyword backstop. */
  severity: Severity | null;
  categories: ReadonlySet<Category>;
  confidence: MarkerConfidence;
  isSummary: boolean;
  nativeTag: string | null;
  escalated: boolean;
  matched: readonly string[];
  /** What the VENDOR itself stamped — only badge vendors, only from a real marker. */
  declaredSeverity: Severity | null;
}

/** Trust in `declaredSeverity`; null when the vendor declared nothing. */
export function declaredConfidence(m: MarkerResult): MarkerConfidence | null {
  return m.declaredSeverity === null ? null : m.confidence;
}

const PRIMARY_PRIORITY: readonly Category[] = [
  'security',
  'correctness_bug',
  'performance',
  'testing',
  'maintainability_refactor',
  'documentation',
  'style_readability',
  'nitpick',
  'praise',
];

/** One representative category: security/correctness first, nitpick last. */
export function primaryCategory(m: MarkerResult): Category | null {
  for (const cat of PRIMARY_PRIORITY) if (m.categories.has(cat)) return cat;
  return null;
}

// ---- Python regex semantics -------------------------------------------------------------------

/** Python `str.isspace()` — what `\s` and `str.strip()` mean on the Python side. */
const PY_WS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　`;
/** Python's Unicode `\w`: `isalnum()` or `_`. Letters and numbers; NOT combining marks. */
const PY_W = String.raw`\p{L}\p{N}_`;
const PY_BOUNDARY = `(?:(?<=[${PY_W}])(?![${PY_W}])|(?<![${PY_W}])(?=[${PY_W}]))`;
const PY_NON_BOUNDARY = `(?:(?<=[${PY_W}])(?=[${PY_W}])|(?<![${PY_W}])(?![${PY_W}]))`;

interface PyFlags {
  i?: boolean;
  m?: boolean;
  s?: boolean;
}

/** Translate a Python `re` source into an equivalent JS source (flags `u` + optional `i`). */
function translate(src: string, flags: PyFlags): string {
  let multiline = flags.m === true;
  if (src.startsWith('(?m)')) {
    multiline = true;
    src = src.slice(4);
  }
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[i + 1];
      i++;
      if (n === undefined) throw new Error(`dangling escape in ${src}`);
      if (inClass) {
        if (n === 's') out += PY_WS;
        else if (n === 'w') out += PY_W;
        else if (n === 'd') out += String.raw`\p{Nd}`;
        else out += `\\${n}`;
      } else if (n === 's') out += `[${PY_WS}]`;
      else if (n === 'S') out += `[^${PY_WS}]`;
      else if (n === 'w') out += `[${PY_W}]`;
      else if (n === 'W') out += `[^${PY_W}]`;
      else if (n === 'd') out += String.raw`\p{Nd}`;
      else if (n === 'D') out += String.raw`\P{Nd}`;
      else if (n === 'b') out += PY_BOUNDARY;
      else if (n === 'B') out += PY_NON_BOUNDARY;
      else out += `\\${n}`;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      out += c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += c;
      if (src[i + 1] === '^') {
        out += '^';
        i++;
      }
      continue;
    }
    if (c === '^') out += multiline ? String.raw`(?<![^\n])` : String.raw`(?<![\s\S])`;
    else if (c === '$') out += multiline ? String.raw`(?![^\n])` : String.raw`(?=\n?(?![\s\S]))`;
    else if (c === '.') out += flags.s ? String.raw`[\s\S]` : String.raw`[^\n]`;
    else out += c;
  }
  return out;
}

/** A compiled Python pattern: `search`, `sub` and `finditer` with Python's semantics. */
class PyRe {
  private readonly once: RegExp;
  private readonly all: RegExp;
  constructor(
    /** The Python source, verbatim — what Python's `pat.pattern` returns. */
    readonly pattern: string,
    flags: PyFlags = {},
  ) {
    const js = translate(pattern, flags);
    const f = flags.i ? 'iu' : 'u';
    this.once = new RegExp(js, f);
    this.all = new RegExp(js, `${f}g`);
  }
  search(text: string): RegExpExecArray | null {
    return this.once.exec(text);
  }
  test(text: string): boolean {
    return this.once.test(text);
  }
  sub(repl: string, text: string): string {
    return text.replace(this.all, () => repl);
  }
  finditer(text: string): IterableIterator<RegExpMatchArray> {
    return text.matchAll(this.all);
  }
}

const re = (pattern: string, flags?: PyFlags): PyRe => new PyRe(pattern, flags);
const FE0F = '️';

const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'gu');
/** Python `str.strip()`. JS `trim()` also eats U+FEFF and keeps \x1c-\x1f and \x85. */
function pyStrip(text: string): string {
  return text.replace(PY_STRIP, '');
}

/** Python `int()` over `\d` matches, which may be any script's decimal digits. */
function pyInt(digits: string): number {
  let n = 0;
  for (const ch of digits) n = n * 10 + decimalValue(ch);
  return n;
}

const ND = /\p{Nd}/u;
function decimalValue(ch: string): number {
  // Unicode lays every decimal digit set out as ten contiguous code points from its zero, so a
  // digit's value is its offset within the run of Nd code points it belongs to.
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

// ---- text prep --------------------------------------------------------------------------------

/** URLs are keyword soup — they never vote on a category or trigger escalation. */
const URL_RE = re(String.raw`https?://\S+`);

/** NFC-normalise and drop the U+FE0F variation selector (emoji matching). */
export function normalizeBody(body: string): string {
  return body.normalize('NFC').replaceAll(FE0F, '');
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Remove unpaired UTF-16 surrogates — what the service's HTTP boundary does to every string
 * field. Dropped, not replaced: an orphan is a truncation artefact, not something the author
 * wrote. (`String.prototype.toWellFormed` would substitute U+FFFD, which the model would read.)
 */
export function dropLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, '');
}

const SECURITY_CRASH_KEYWORDS: readonly string[] = [
  'rce',
  'remote code execution',
  'sql injections?',
  'sqli',
  'xss',
  'csrf',
  'null pointers?',
  'nullpointerexception',
  'npe',
  'segfaults?',
  'data loss',
  'data corruption',
  'race conditions?',
  'deadlocks?',
  'buffer overflows?',
  'use-after-free',
  'path traversals?',
  'arbitrary code',
  'privilege escalations?',
  'authentication bypass(?:es)?',
  'credentials?',
  'secret leaks?',
  'hardcoded passwords?',
];
const SECURITY_CRASH_RE = re(String.raw`\b(?:` + SECURITY_CRASH_KEYWORDS.join('|') + String.raw`)\b`, {
  i: true,
});

/** A whole crash/security word, outside any URL. */
export function hasSecurityCrashKw(text: string): boolean {
  return SECURITY_CRASH_RE.test(URL_RE.sub(' ', text));
}

const PRAISE_PHRASES: readonly string[] = [
  'original finding is resolved',
  'resolves the original concern',
  'original concern is resolved',
  'thanks for addressing',
  'thanks for the fix',
  'thanks for clarifying',
  'thanks for the correction',
  'withdrawing this suggestion',
  'withdrawing my suggestion',
  'i withdraw',
  'no further action needed',
  'no action needed',
  'shout-out on [x]',
  'giving us a shout-out',
];

/** A praise / acknowledgment reply rather than a finding. Deliberately narrow. */
export function looksPraise(text: string): boolean {
  const low = text.toLowerCase();
  return PRAISE_PHRASES.some((p) => low.includes(p));
}

// ---- vendor chrome stripping (the model's input text) -----------------------------------------

const CHROME_HTML_COMMENT = re('<!--.*?-->', { s: true });
const CHROME_DETAILS = re(String.raw`<details\b[^>]*>.*?</details>`, { s: true, i: true });
const CHROME_TAGS = re(String.raw`</?(?:details|summary|blockquote|sub|sup|br)\b[^>]*>`, { i: true });
const CHROME_BADGES = re(
  String.raw`🔴\s*Critical|🟠\s*Major|🟡\s*Minor|🔵\s*Trivial|⚪\s*Info|` +
    String.raw`⚠\s*Outside diff range|⚠\s*Potential issue|🛠\s*Refactor suggestion|` +
    String.raw`🧹\s*Nitpick|⚡\s*Quick win|🔒\s*Security(?:\s*&\s*Privacy)?|` +
    String.raw`🧩\s*Analysis chain|🏁\s*Script executed|` +
    String.raw`🎯\s*Functional Correctness|📐\s*Maintainability(?:\s*&\s*Code Quality)?|` +
    String.raw`🗄\s*Data Integrity(?:\s*&\s*Integration)?|🩺\s*Stability(?:\s*&\s*Availability)?|` +
    String.raw`🚀\s*Performance(?:\s*&\s*Scalability)?`,
  { i: true },
);
const CHROME_PREFIX = re(
  String.raw`^\s*\**(?:issue|suggestion|nitpick|question|warning|note)\**\s*(?:\([a-z_ ]+\))?\s*:\s*`,
  { i: true, m: true },
);
const CHROME_EMPTY_ITALIC = re(String.raw`_\s*_`);
const CHROME_BARE_EMOJI = re(String.raw`(?m)^\s*[🔴🟠🟡🔵⚪]\s*`);
const CHROME_ORPHAN_BOLD = re(String.raw`(?m)^\s*\*\*\s+`);
const CHROME_PUNCT_LINE = re(String.raw`^[\s_|*>#-]*$`, { m: true });
const CHROME_MULTIBLANK = re(String.raw`\n{3,}`);
const CHROME_AI_DISCLAIMER = re(String.raw`^\s*You are interacting with an AI system\.?\s*$`, {
  i: true,
  m: true,
});

const RESOLUTION_VERB = String.raw`(?:confirmed\s+as\s+addressed|verified\s+as\s+(?:resolved|addressed)|addressed|resolved)`;
/** A vendor's own "this is fixed" footer. Two deliberately narrow branches: see markers.py. */
const CHROME_RESOLUTION = re(
  String.raw`^[ \t>*_]*(?:` +
    String.raw`✅\s*\**\s*${RESOLUTION_VERB}\b` +
    String.raw`|${RESOLUTION_VERB}\s+(?:in|by)\s+(?:commits?\s+)?[` +
    '`' +
    String.raw`*]{0,2}[0-9a-f]{7,40}\b` +
    String.raw`)[^\n]*$`,
  { i: true, m: true },
);

/** Drop resolution footers — unless they are ALL the comment has. */
function stripResolutionFooters(text: string): string {
  const stripped = CHROME_RESOLUTION.sub('', text);
  if (!pyStrip(CHROME_PUNCT_LINE.sub('', stripped))) return text;
  return stripped;
}

/**
 * Strip a vendor's own severity/verdict chrome, keeping the finding — the text the severity
 * model was trained on. NOT used for label extraction: `extractMarkers` reads the raw body.
 */
export function stripVendorChrome(body: string): string {
  let text = normalizeBody(body);
  text = CHROME_HTML_COMMENT.sub(' ', text);
  text = CHROME_DETAILS.sub('\n', text);
  text = CHROME_BADGES.sub('', text);
  text = CHROME_BARE_EMOJI.sub('', text);
  text = CHROME_PREFIX.sub('', text);
  text = CHROME_ORPHAN_BOLD.sub('', text);
  text = CHROME_TAGS.sub('', text);
  text = CHROME_EMPTY_ITALIC.sub('', text);
  text = CHROME_AI_DISCLAIMER.sub('', text);
  text = stripResolutionFooters(text);
  text = CHROME_PUNCT_LINE.sub('', text);
  text = CHROME_MULTIBLANK.sub('\n\n', text);
  return pyStrip(text);
}

// ---- keyword → category (backstop + keyword-only vendors) -------------------------------------

const CATEGORY_PATTERNS: readonly (readonly [Category, PyRe])[] = (
  [
    [
      'security',
      String.raw`\bsecurity\b|\bvulnerab\w*|\binjection\b|\bxss\b|\bcsrf\b|\bssrf\b|` +
        String.raw`\bauth\b|\bauthn\b|\bauthz\b|\bauthenticat\w*|\bauthoriz\w*|\bauthoris\w*|` +
        String.raw`\boauth\b|\bsecrets?\b|\bcredentials?\b|\bsanitiz\w*|\bsanitis\w*|\bexploit\w*`,
    ],
    [
      'correctness_bug',
      String.raw`\bbugs?\b|\bnull\b|\bnpe\b|\bexceptions?\b|\bcrash\w*|\bincorrect\w*|` +
        String.raw`race condition|\bdeadlocks?\b|off-by-one|logic error|will fail|\bthrows?\b|` +
        String.raw`undefined behavior`,
    ],
    [
      'performance',
      String.raw`\bperformance\b|\bslow(?:er|ness)?\b|\bo\(n|n\+1|memory leak|\binefficien\w*|` +
        String.raw`\ballocations?\b|\blatency\b|\bbottlenecks?\b`,
    ],
    [
      'testing',
      String.raw`\btests?\b|\btesting\b|\btested\b|\bcoverage\b|\bassert(?:s|ions?)?\b|` +
        String.raw`\bmocks?\b|\bfixtures?\b|unit tests?`,
    ],
    [
      'documentation',
      String.raw`\bdocstrings?\b|\bdocumentation\b|\bcomments?\b|\btypos?\b|\breadme\b|` +
        String.raw`\bspelling\b|\bgrammar\b`,
    ],
    [
      'maintainability_refactor',
      String.raw`\brefactor\w*|\bduplicat\w*|\bcomplexity\b|\bmaintainab\w*|\breadability\b|` +
        String.raw`\bextract\w*|\bsimplif\w*|dead code`,
    ],
    [
      'style_readability',
      String.raw`\bstyle\b|\bformat(?:ting|ted)?\b|\blint(?:er|ing)?\b|\bnaming\b|` +
        String.raw`\bindentation\b|\bconventions?\b`,
    ],
    ['nitpick', String.raw`\bnits?\b|\bnitpicks?\b|\bminor\b|\btrivial\b|\boptional\b|\bpreference\b`],
  ] as const
).map(([cat, src]) => [cat, re(src, { i: true })] as const);

export function inferCategoriesFromText(text: string): Set<Category> {
  const low = URL_RE.sub(' ', text);
  return new Set(CATEGORY_PATTERNS.filter(([, pat]) => pat.test(low)).map(([cat]) => cat));
}

/** The body minus HTML comments and `<details>` — where newer vendors park file paths. */
function proseForCategories(body: string): string {
  return CHROME_DETAILS.sub(' ', CHROME_HTML_COMMENT.sub(' ', body));
}

const LOOKS_SECURITY_RE = re(
  String.raw`\bsecurity\b|\binjection\b|\bxss\b|\bcsrf\b|\bssrf\b|\brce\b|` +
    String.raw`\bauth\b|\bauthn\b|\bauthz\b|\bauthenticat\w*|\bauthoriz\w*|\bauthoris\w*|\boauth\b|` +
    String.raw`\bsecrets?\b|\bcredentials?\b|\bvulnerab\w*|\bexploit\w*|\btraversal\b`,
  { i: true },
);

function looksSecurity(text: string): boolean {
  return LOOKS_SECURITY_RE.test(URL_RE.sub(' ', text));
}

/** Escalate one level, and add SECURITY when it reads as security, on crash/security words. */
function escalateForSecurity(
  sev: Severity | null,
  cats: Set<Category>,
  text: string,
): [Severity | null, Set<Category>, boolean] {
  if (!hasSecurityCrashKw(text)) return [sev, cats, false];
  const newCats = looksSecurity(text) ? new Set([...cats, 'security' as const]) : cats;
  if (sev === null) return ['MAJOR', newCats, true];
  return [escalate(sev, 1), newCats, SEVERITY_ORD[sev] < SEVERITY_ORD.CRITICAL];
}

// ---- per-vendor extractors --------------------------------------------------------------------

/** Patterns tried in order; the first hit wins (Python's `for … break`). */
function firstSeverity(
  table: readonly (readonly [PyRe, Severity])[],
  body: string,
  matched: string[],
): Severity | null {
  for (const [pat, sev] of table) {
    if (pat.test(body)) {
      matched.push(pat.pattern);
      return sev;
    }
  }
  return null;
}

const CR_SUMMARY = re(
  String.raw`auto-generated comment: summarize by coderabbit\.ai|Actionable comments posted:\s*\d+`,
  { i: true },
);
const CR_SEV: readonly (readonly [PyRe, Severity])[] = [
  [re(String.raw`🔴\s*Critical`, { i: true }), 'CRITICAL'],
  [re(String.raw`🟠\s*Major`, { i: true }), 'MAJOR'],
  [re(String.raw`🟡\s*Minor`, { i: true }), 'MINOR'],
  [re(String.raw`🔵\s*Trivial`, { i: true }), 'NIT'],
  [re(String.raw`⚪\s*Info`, { i: true }), 'NIT'],
];
const CR_TYPE: readonly (readonly [PyRe, Severity, Category])[] = [
  [re(String.raw`⚠${FE0F}?\s*Outside diff range`, { i: true }), 'MAJOR', 'correctness_bug'],
  [re(String.raw`⚠${FE0F}?\s*Potential issue`, { i: true }), 'MAJOR', 'correctness_bug'],
  [re(String.raw`🛠${FE0F}?\s*Refactor suggestion`, { i: true }), 'MINOR', 'maintainability_refactor'],
  [re(String.raw`🧹\s*Nitpick`, { i: true }), 'NIT', 'nitpick'],
];
const CR_CATEGORY: readonly (readonly [PyRe, Category])[] = [
  [re(String.raw`🎯\s*Functional Correctness`, { i: true }), 'correctness_bug'],
  [re(String.raw`📐\s*Maintainability(?:\s*&\s*Code Quality)?`, { i: true }), 'maintainability_refactor'],
  [re(String.raw`🗄\s*Data Integrity(?:\s*&\s*Integration)?`, { i: true }), 'correctness_bug'],
  [re(String.raw`🩺\s*Stability(?:\s*&\s*Availability)?`, { i: true }), 'correctness_bug'],
  [re(String.raw`🔒\s*Security(?:\s*&\s*Privacy)?`, { i: true }), 'security'],
  [re(String.raw`🚀\s*Performance(?:\s*&\s*Scalability)?`, { i: true }), 'performance'],
];

function extractCoderabbit(body: string): MarkerResult {
  const isSummary = CR_SUMMARY.test(body);
  const matched: string[] = [];
  let sev = firstSeverity(CR_SEV, body, matched);
  let cats = new Set<Category>();
  for (const [pat, s, c] of CR_TYPE) {
    if (pat.test(body)) {
      cats.add(c);
      matched.push(pat.pattern);
      if (sev === null) sev = s; // an explicit severity emoji beats the type default
    }
  }
  for (const [pat, c] of CR_CATEGORY) {
    if (pat.test(body)) {
      cats.add(c);
      matched.push(pat.pattern);
    }
  }
  if (cats.size === 0) cats = inferCategoriesFromText(body);
  return finalize('coderabbit', sev, cats, 'high', body, isSummary, matched);
}

const QODO_SUMMARY = re('PR Reviewer Guide|Estimated effort to review|PR Code Suggestions', { i: true });
const QODO_SEC = re(String.raw`Security concerns:?\s*Yes|possible security issue`, { i: true });
const QODO_ISSUES = re('Possible issues|Key issues to review', { i: true });
const QODO_IMPORTANCE = re(String.raw`importance[^0-9]{0,12}(\d{1,2})|\[(\d{1,2})/10\]`, { i: true });

function extractQodo(body: string): MarkerResult {
  const isSummary = QODO_SUMMARY.test(body);
  const matched: string[] = [];
  let sev: Severity | null = null;
  let cats = new Set<Category>();
  if (QODO_SEC.test(body)) {
    sev = 'CRITICAL';
    matched.push('security_concerns');
    cats.add('security');
  } else if (QODO_ISSUES.test(body)) {
    sev = 'MAJOR';
    matched.push('possible_issues');
    cats.add('correctness_bug');
  }
  const m = QODO_IMPORTANCE.search(body);
  if (m && sev === null) {
    const num = pyInt((m[1] || m[2])!);
    sev = num >= 8 ? 'MAJOR' : num >= 5 ? 'MINOR' : 'NIT';
    matched.push(`importance=${num}`);
  }
  if (cats.size === 0) cats = inferCategoriesFromText(body);
  return finalize('qodo', sev, cats, 'high', body, isSummary, matched);
}

const SOURCERY_PREFIX = re(
  String.raw`^\s*\**(issue|suggestion|nitpick|question)\**(?:\s*\(([a-z_]+)\))?\s*:`,
  { i: true, m: true },
);
const SOURCERY_CAT: Readonly<Record<string, readonly [Severity, Category]>> = {
  security: ['CRITICAL', 'security'],
  bug_risk: ['MAJOR', 'correctness_bug'],
  performance: ['MAJOR', 'performance'],
  complexity: ['MINOR', 'maintainability_refactor'],
  typo: ['NIT', 'documentation'],
  testing: ['MINOR', 'testing'],
};
const SOURCERY_KIND_SEV: Readonly<Record<string, Severity>> = {
  issue: 'MAJOR',
  suggestion: 'MINOR',
  nitpick: 'NIT',
  question: 'NIT',
};

function extractSourcery(body: string): MarkerResult {
  const m = SOURCERY_PREFIX.search(body);
  if (!m) return finalize('sourcery', null, inferCategoriesFromText(body), 'medium', body, false, []);
  const kind = m[1]!.toLowerCase();
  const paren = (m[2] ?? '').toLowerCase();
  let sev: Severity = Object.hasOwn(SOURCERY_KIND_SEV, kind) ? SOURCERY_KIND_SEV[kind]! : 'MINOR';
  const cats = new Set<Category>();
  if (Object.hasOwn(SOURCERY_CAT, paren)) {
    const [psev, pcat] = SOURCERY_CAT[paren]!;
    cats.add(pcat);
    sev = maxSeverity(sev, psev); // a parenthesised category can raise severity
  }
  if (kind === 'nitpick') cats.add('nitpick');
  if (cats.size === 0) cats.add(kind === 'suggestion' ? 'maintainability_refactor' : 'correctness_bug');
  return finalize('sourcery', sev, cats, 'high', body, false, [paren ? `${kind}(${paren})` : kind]);
}

const COPILOT_SUPPRESSED = re(String.raw`Comments suppressed due to low confidence\s*\((\d+)\)`, {
  i: true,
});
const COPILOT_SEV: readonly (readonly [PyRe, Severity])[] = [
  [re(String.raw`\b(High)\b(?:\s*(?:severity|confidence|priority))?`, { i: true }), 'MAJOR'],
  [re(String.raw`\bMedium\b`, { i: true }), 'MINOR'],
  [re(String.raw`\bLow\b`, { i: true }), 'NIT'],
];

function extractCopilot(body: string): MarkerResult {
  const isSummary = COPILOT_SUPPRESSED.test(body);
  const matched: string[] = [];
  const sev = firstSeverity(COPILOT_SEV, body, matched);
  return finalize('copilot', sev, inferCategoriesFromText(body), 'high', body, isSummary, matched);
}

const GRAPHITE_PREFIX = re(String.raw`^\s*\*{0,2}(Blocking|Optional|Nit|FYI)\*{0,2}\s*:`, {
  i: true,
  m: true,
});
const GRAPHITE_MAP: Readonly<Record<string, readonly [Severity, Category]>> = {
  blocking: ['CRITICAL', 'correctness_bug'],
  optional: ['MINOR', 'maintainability_refactor'],
  nit: ['NIT', 'style_readability'],
  fyi: ['NIT', 'documentation'],
};

function extractGraphite(body: string): MarkerResult {
  const m = GRAPHITE_PREFIX.search(body);
  if (!m) return finalize('graphite', null, inferCategoriesFromText(body), 'medium', body, false, []);
  const tag = m[1]!.toLowerCase();
  const [sev, cat] = GRAPHITE_MAP[tag]!;
  const cats = new Set<Category>([cat, ...inferCategoriesFromText(body)]);
  return finalize('graphite', sev, cats, 'high', body, false, [tag]);
}

const CURSOR_SUMMARY = re(String.raw`<!--\s*BUGBOT_REVIEW\s*-->|Cursor Bugbot has reviewed your changes`, {
  i: true,
});
const CURSOR_BUG_ID = re(String.raw`<!--\s*BUGBOT_BUG_ID\s*:`, { i: true });
/** Anchored on the BOLDED form: a bare "High" in prose is not Cursor's claim. */
const CURSOR_SEV: readonly (readonly [PyRe, Severity])[] = [
  [re(String.raw`\*\*\s*High\s+Severity\s*\*\*`, { i: true }), 'MAJOR'],
  [re(String.raw`\*\*\s*Medium\s+Severity\s*\*\*`, { i: true }), 'MINOR'],
  [re(String.raw`\*\*\s*Low\s+Severity\s*\*\*`, { i: true }), 'NIT'],
];

function extractCursor(body: string): MarkerResult {
  const isSummary = CURSOR_SUMMARY.test(body);
  const matched: string[] = [];
  const sev = firstSeverity(CURSOR_SEV, body, matched);
  if (sev !== null && CURSOR_BUG_ID.test(body)) matched.push('bugbot_bug_id');
  const cats = inferCategoriesFromText(proseForCategories(body));
  return finalize('cursor', sev, cats, matched.length ? 'high' : 'medium', body, isSummary, matched);
}

const CODEX_SUMMARY = re(String.raw`###\s*💡?\s*Codex Review|Here are some automated review suggestions`, {
  i: true,
});
const CODEX_BADGE = re(String.raw`img\.shields\.io/badge/P([0-3])\b`, { i: true });
const CODEX_PRIORITY: Readonly<Record<string, Severity>> = {
  '0': 'CRITICAL',
  '1': 'MAJOR',
  '2': 'MINOR',
  '3': 'NIT',
};

function extractCodex(body: string): MarkerResult {
  const isSummary = CODEX_SUMMARY.test(body);
  const matched: string[] = [];
  let sev: Severity | null = null;
  const m = CODEX_BADGE.search(body);
  if (m) {
    sev = CODEX_PRIORITY[m[1]!]!;
    matched.push(`P${m[1]}`);
  }
  const cats = inferCategoriesFromText(proseForCategories(body));
  return finalize('codex', sev, cats, matched.length ? 'high' : 'medium', body, isSummary, matched);
}

const DEEPSOURCE_SUMMARY = re(
  String.raw`<span>\s*DeepSource Code Review\s*</span>|Below is the summary for the review`,
  { i: true },
);
const DEEPSOURCE_SEV = re(String.raw`severity_indicator_([a-z_]+)\.svg`, { i: true });
const DEEPSOURCE_SEV_NAMES: Readonly<Record<string, Severity>> = {
  critical: 'CRITICAL',
  major: 'MAJOR',
  minor: 'MINOR',
};
const DEEPSOURCE_CAT = re(String.raw`category_([a-z_]+)\.svg`, { i: true });
const DEEPSOURCE_CAT_NAMES: Readonly<Record<string, Category>> = {
  bug_risk: 'correctness_bug',
  security: 'security',
  performance: 'performance',
  antipattern: 'maintainability_refactor',
  doc: 'documentation',
  style: 'style_readability',
  coverage: 'testing',
  typecheck: 'correctness_bug',
};

function extractDeepsource(body: string): MarkerResult {
  const isSummary = DEEPSOURCE_SUMMARY.test(body);
  const matched: string[] = [];
  let sev: Severity | null = null;
  const m = DEEPSOURCE_SEV.search(body);
  if (m) {
    const name = m[1]!.toLowerCase();
    if (Object.hasOwn(DEEPSOURCE_SEV_NAMES, name)) {
      sev = DEEPSOURCE_SEV_NAMES[name]!;
      matched.push(`severity_indicator_${name}`);
    }
  }
  let cats = new Set<Category>();
  // Each chip is spelled three times (dark, light, fallback): dedupe by name, keep first order.
  const names = new Set([...DEEPSOURCE_CAT.finditer(body)].map((cm) => cm[1]!.toLowerCase()));
  for (const name of names) {
    if (Object.hasOwn(DEEPSOURCE_CAT_NAMES, name)) {
      cats.add(DEEPSOURCE_CAT_NAMES[name]!);
      matched.push(`category_${name}`);
    }
  }
  if (cats.size === 0) cats = inferCategoriesFromText(proseForCategories(body));
  return finalize('deepsource', sev, cats, matched.length ? 'high' : 'medium', body, isSummary, matched);
}

const WORD_SEV: readonly (readonly [PyRe, Severity])[] = [
  [re(String.raw`\bCritical\b`, { i: true }), 'CRITICAL'],
  [re(String.raw`\bHigh\b`, { i: true }), 'MAJOR'],
  [re(String.raw`\bMedium\b`, { i: true }), 'MINOR'],
  [re(String.raw`\bLow\b`, { i: true }), 'NIT'],
];

/** Korbit / Bito: severity words + keyword categories. */
function extractWordSeverity(vendor: Kind, body: string): MarkerResult {
  const matched: string[] = [];
  const sev = firstSeverity(WORD_SEV, body, matched);
  return finalize(vendor, sev, inferCategoriesFromText(body), 'medium', body, false, matched);
}

/** Everyone else: the keyword lexicon infers both axes. */
function extractKeywordOnly(vendor: Kind, body: string): MarkerResult {
  const cats = inferCategoriesFromText(body);
  let sev: Severity | null = null;
  if (cats.has('security') || cats.has('correctness_bug')) sev = 'MAJOR';
  else if (cats.has('nitpick') || cats.has('style_readability')) sev = 'NIT';
  else if (cats.size > 0) sev = 'MINOR';
  return finalize(vendor, sev, cats, cats.size > 0 ? 'medium' : 'low', body, false, []);
}

// ---- finalize + dispatch ----------------------------------------------------------------------

/**
 * Vendors whose severity comes from a marker THE VENDOR EMITTED, and may therefore be shown as
 * "the vendor's own call". Everyone else's severity is our inference and must never be
 * attributed to them.
 */
const BADGE_VENDORS: ReadonlySet<Kind> = new Set<Kind>([
  'coderabbit',
  'qodo',
  'sourcery',
  'copilot',
  'graphite',
  'korbit',
  'bito',
  'cursor',
  'codex',
  'deepsource',
]);

function finalize(
  vendor: Kind,
  sev: Severity | null,
  cats: Set<Category>,
  conf: MarkerConfidence,
  body: string,
  isSummary: boolean,
  matched: string[],
): MarkerResult {
  // The vendor's own call, captured before escalation and the praise override rewrite `sev`.
  const declared = BADGE_VENDORS.has(vendor) ? sev : null;
  // A summary is not a finding: no severity, no categories, nothing declared.
  if (isSummary) {
    return {
      vendor,
      severity: null,
      categories: new Set(),
      confidence: conf,
      isSummary: true,
      nativeTag: matched[0] ?? null,
      escalated: false,
      matched,
      declaredSeverity: null,
    };
  }
  // A praise / resolution reply with no badge of its own is not a finding either.
  if (sev === null && looksPraise(body)) {
    return {
      vendor,
      severity: 'NIT',
      categories: new Set(['praise']),
      confidence: conf,
      isSummary: false,
      nativeTag: 'praise',
      escalated: false,
      matched: [...matched, 'praise'],
      declaredSeverity: declared,
    };
  }
  const [finalSev, finalCats, escalated] = escalateForSecurity(sev, cats, body);
  return {
    vendor,
    severity: finalSev,
    categories: finalCats,
    confidence: conf,
    isSummary,
    nativeTag: matched[0] ?? null,
    escalated,
    matched,
    declaredSeverity: declared,
  };
}

const DISPATCH: Partial<Record<Kind, (body: string) => MarkerResult>> = {
  coderabbit: extractCoderabbit,
  qodo: extractQodo,
  sourcery: extractSourcery,
  copilot: extractCopilot,
  graphite: extractGraphite,
  cursor: extractCursor,
  codex: extractCodex,
  deepsource: extractDeepsource,
};

/** A `(severity, categories)` weak-label seed, plus the vendor's own claim, for one body. */
export function extractMarkers(vendor: Kind, body: string): MarkerResult {
  const norm = normalizeBody(body);
  const extract = DISPATCH[vendor];
  if (extract) return extract(norm);
  if (vendor === 'korbit' || vendor === 'bito') return extractWordSeverity(vendor, norm);
  return extractKeywordOnly(vendor, norm);
}

/**
 * The vendor string a caller sends → the Kind the extractors dispatch on, as the service's
 * `coerce_vendor` does. Python falls back to resolving the string as a GitHub LOGIN, but every
 * string this backend sends is a vendor KIND (`vendorHint`), and every one of those outside the
 * enum resolves to `unknown` there — pinned against the exporter's `coercion.json`.
 */
export function coerceVendor(value: string | null | undefined): Kind {
  if (!value) return 'unknown';
  const low = value.toLowerCase();
  return KINDS.has(low) ? (low as Kind) : 'unknown';
}
