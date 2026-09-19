// DEPENDENCY + SECURITY DETECTION — the ONE spelling of every vendor marker and advisory regex.
//
// Pure: no DB, no network, no imports but types. Two consumers:
//   • `persistPr` / the one-shot backfill (PR level, at SYNC) — `classifyPrSecurity` reads a PR's
//     title, branch, labels and FULL `bodyText` and yields the three small columns that are stored
//     (`dependency_vendor`, `security_fix`, `advisory_ids`).
//   • `db/security-alerts.ts` (comment level, on READ) — `evaluateSecurityAlerts` folds the stored
//     comment / review / thread-root bodies of open PRs into live automation ALERTS.
//
// ⚠ SCOPE IS KNOWN ADVISORIES ONLY (decisions §5). A vendor's own fix PR, or an automation alert
// that names an advisory id from the allow-list below. NOT: CWE weakness classes, SAST findings,
// secrets, malware, an AI reviewer's passing mention inside quoted material, an "all clear" post,
// or the CVE an ordinary bump's release notes happen to cite.
//
// ⚠ VENDOR RULES FIRST, IDS SECOND. An id regex alone is the wrong detector: 6 of 153 stored
// Dependabot bodies are plain version bumps whose release notes cite a CVE, while 12 of the 19 real
// Dependabot security PRs name no id at all. The marker decides; ids only describe.

// ---------------------------------------------------------------------------------------------
// Advisory ids — an ALLOW-list, never a catch-all
// ---------------------------------------------------------------------------------------------

export type AdvisoryScheme =
  | 'cve'
  | 'ghsa'
  | 'rustsec'
  | 'pysec'
  | 'go'
  | 'osv'
  | 'snyk'
  | 'aikido'
  | 'semgrep';

/** ⚠ EXCLUDED ON PURPOSE: CWE-* (a weakness CLASS, not an advisory), MAL-* (malware — out of scope,
 *  decisions §5), KSV-* and AVD-* (Trivy misconfiguration), distro ids (DSA/USN/RHSA… — container scans,
 *  unverified here). Adding one is a product decision, not a regex tweak.
 *
 *  ⚠ These run over attacker-authored text (any comment on a tracked repo), on read and at sync, so
 *  each must stay LINEAR: no unbounded repetition that can backtrack across the next match start.
 *
 *  ⚠ SNYK IS CASE-SENSITIVE AND ITS SEGMENTS ARE BOUNDED. Real ids are always uppercase, while every
 *  Snyk PR-check comment links `…itemName=snyk-security.snyk-vulnerability-scanner-vs-2022`, which a
 *  case-insensitive pattern reads as the id `SNYK-VULNERABILITY-SCANNER-VS-2022`. An unbounded
 *  segment group made `'SNYK-'.repeat(13000)` take 1.5 s; eight segments is twice the longest seen. */
export const ADVISORY_ID_PATTERNS: readonly { scheme: AdvisoryScheme; re: RegExp }[] = [
  { scheme: 'cve', re: /\bCVE-\d{4}-\d{4,}\b/gi },
  { scheme: 'ghsa', re: /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/gi },
  { scheme: 'rustsec', re: /\bRUSTSEC-\d{4}-\d{4}\b/gi },
  { scheme: 'pysec', re: /\bPYSEC-\d{4}-\d+\b/gi },
  { scheme: 'go', re: /\bGO-\d{4}-\d{4,}\b/gi },
  { scheme: 'osv', re: /\bOSV-\d{4}-\d+\b/gi },
  { scheme: 'snyk', re: /\bSNYK-[A-Z0-9]+(?:-[A-Z0-9_.]+){0,8}-\d+\b/g },
  { scheme: 'aikido', re: /\bAIKIDO-\d{4}-\d+\b/gi },
  { scheme: 'semgrep', re: /\bssc-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi },
];

/** Canonical form: GHSA → 'GHSA-' + lowercase groups; `ssc-` lowercase; everything else UPPERCASE. */
export function canonicalAdvisoryId(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.startsWith('ghsa-')) return `GHSA-${lower.slice(5)}`;
  if (lower.startsWith('ssc-')) return lower;
  return raw.toUpperCase();
}

/** Distinct canonical ids in first-seen order, capped at `max` (default 50 — a safety cap, not a
 *  display cap; stated so a reader knows the list is complete below it). */
export function extractAdvisoryIds(text: string, max = 50): string[] {
  // Every scheme's matches, ordered by POSITION in the text — "first seen" is a reading order,
  // not a scheme order, so a body naming a GHSA before its CVE lists them that way round.
  const hits: { at: number; id: string }[] = [];
  for (const { re } of ADVISORY_ID_PATTERNS) {
    for (const m of text.matchAll(re)) hits.push({ at: m.index ?? 0, id: canonicalAdvisoryId(m[0]) });
  }
  hits.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h.id);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// PR-level classification (runs at sync)
// ---------------------------------------------------------------------------------------------

export interface PrSecurityInput {
  title: string;
  /** `headRefName` — GitHub types it String!, so present on every real response. */
  headRefName: string | null;
  labels: readonly string[];
  /** The FULL `bodyText`. ⚠ NEVER `search_index` (4,000-char cap: the Dependabot footer is the LAST
   *  line of a body that runs to 65 KB). */
  bodyText: string;
}

export type DependencyMarkerVendor =
  | 'dependabot'
  | 'renovate'
  | 'snyk'
  | 'depfu'
  | 'mend'
  | 'aikido'
  | 'socket'
  | 'frogbot'
  | 'checkmarx'
  | 'pyup'
  | 'greenkeeper';

export interface PrSecuritySignal {
  /** The dependency/remediation tool whose OWN marker is on this PR — CONTENT ONLY, never the
   *  author login (the author half is resolved on read, per workspace). */
  dependencyVendor: DependencyMarkerVendor | null;
  /** 'proven' = the tool's own security marker; 'inferred' = rule 2b (Dependabot's ecosystem-named
   *  group whose body was truncated). null = not a known-advisory fix (including every ordinary
   *  bump whose release notes quote a CVE). */
  securityFix: 'proven' | 'inferred' | null;
  /** Ids named by the VENDOR-SELECTED fields only (title, branch, body before the release notes).
   *  Empty unless `securityFix` is set. */
  advisoryIds: string[];
}

interface VendorMarker {
  vendor: DependencyMarkerVendor;
  branch: readonly (string | RegExp)[];
  title: readonly string[];
  body: readonly string[];
}

/** Rule 1, first match wins. Branch and title are PREFIX matches — a title or branch that merely
 *  CONTAINS a vendor word is not a marker (`trufflesecurity/trufflehog` is nobody's). Body markers
 *  are each tool's own boilerplate sentence, verbatim. */
const VENDOR_MARKERS: readonly VendorMarker[] = [
  {
    vendor: 'dependabot',
    branch: ['dependabot/'],
    title: [],
    body: ['You can trigger Dependabot actions by commenting on this PR'],
  },
  { vendor: 'renovate', branch: ['renovate/'], title: [], body: [] },
  {
    vendor: 'snyk',
    branch: ['snyk-fix-', 'snyk-upgrade-'],
    title: ['[Snyk] '],
    body: ['This PR was automatically created by Snyk', 'Snyk has created this PR to'],
  },
  { vendor: 'depfu', branch: ['depfu/'], title: [], body: [] },
  {
    vendor: 'mend',
    branch: ['whitesource-remediate/'],
    title: [],
    body: ['By merging this PR, the below vulnerabilities will be automatically resolved'],
  },
  {
    vendor: 'aikido',
    branch: [/^fix\/AIK-\d+/],
    title: ['[Aikido] '],
    body: ['This PR will resolve the following CVEs'],
  },
  { vendor: 'socket', branch: ['socket/fix/'], title: [], body: ['Socket fix for GHSA-'] },
  {
    vendor: 'frogbot',
    branch: ['frogbot-'],
    title: ['[🐸 Frogbot]'],
    body: ['This automated pull request was created by Frogbot'],
  },
  {
    vendor: 'checkmarx',
    branch: ['cx-ai-agent-'],
    title: ['Checkmarx AI Remediation'],
    body: ['Checkmarx One – Remediation'],
  },
  { vendor: 'pyup', branch: ['pyup-', 'pyup/'], title: [], body: [] },
  { vendor: 'greenkeeper', branch: ['greenkeeper/'], title: [], body: [] },
];

/** Checkmarx labels its AI remediation PRs; its title and branch are a person's to rename. */
const CHECKMARX_LABEL = 'cx-ai-agent';

function markerVendor(input: PrSecurityInput): DependencyMarkerVendor | null {
  const branch = input.headRefName ?? '';
  for (const m of VENDOR_MARKERS) {
    const byBranch = m.branch.some((b) => (typeof b === 'string' ? branch.startsWith(b) : b.test(branch)));
    if (
      byBranch ||
      m.title.some((t) => input.title.startsWith(t)) ||
      m.body.some((s) => input.bodyText.includes(s))
    ) {
      return m.vendor;
    }
  }
  if (input.labels.includes(CHECKMARX_LABEL)) return 'checkmarx';
  return null;
}

/** Dependabot's security footer — the last line of its "commands and options" block, present on
 *  every security update and on no version update (0 of 147 stored version-update bodies). */
const DEPENDABOT_SECURITY_FOOTER = 'You can disable automated security fix PRs for this repo';
/** Dependabot's own note when it cut a body to fit GitHub's 65,536-character limit. */
const DEPENDABOT_TRUNCATION_NOTE = 'Description has been truncated';

/** Dependabot's ecosystem ids. A GROUP named after one is the "grouped security updates" setting;
 *  a person names their version groups (`tools`, `build`, `dev-dependencies`). */
const DEPENDABOT_ECOSYSTEMS =
  'npm_and_yarn|pip|uv|bundler|go_modules|cargo|maven|gradle|nuget|composer|docker|docker_compose|' +
  'github_actions|mix|pub|swift|terraform|elm|gitsubmodule|hex|devcontainers|dotnet_sdk|bun|helm';
const ECOSYSTEM_GROUP_TITLE = new RegExp(`\\bbump the (${DEPENDABOT_ECOSYSTEMS}) group\\b`, 'i');
const GROUP_UPDATE_COUNT = /\bwith (\d+) updates?\b/i;
/** The per-dependency section headers of a grouped Dependabot body, as `bodyText` renders them —
 *  one per dependency (a dependency bumped in two directories gets two, so count DISTINCT names). */
const GROUP_SECTION = /^(?:Updates (\S+) from \S+ to \S+|Updates the requirements on (\S+) to .*|Removes (\S+))\s*$/gm;

/** Was this Dependabot body cut short? Two signs, either suffices:
 *   1. Dependabot's own truncation note.
 *   2. ⚠ The body names FEWER distinct dependencies than its title counts. MEASURED on the real
 *      `bodyText` of all seven inferred PRs: the markdown is cut at 65,536 characters, sometimes
 *      INSIDE an HTML tag (`(<a href="…`), and the text renderer then swallows everything after
 *      the unclosed tag — the note included. erxes#7874 and #8042 lose the note that way, and name
 *      6 of 15 and 5 of 13 dependencies; the five that keep it, and both complete bodies measured
 *      (drizzle#5757 8 of 8, azhar22k/ourl#21 2 of 2), name them all.
 *  "Footer missing" is NOT a sign: 26 of 46 real OPEN Dependabot bodies are complete and have no
 *  commands block at all (D9). */
function dependabotBodyTruncated(title: string, bodyText: string): boolean {
  if (bodyText.includes(DEPENDABOT_TRUNCATION_NOTE)) return true;
  const count = GROUP_UPDATE_COUNT.exec(title);
  if (!count) return false;
  const named = new Set<string>();
  for (const m of bodyText.matchAll(GROUP_SECTION)) named.add((m[1] ?? m[2] ?? m[3])!.toLowerCase());
  return named.size < Number(count[1]);
}

function securityFixFor(
  vendor: DependencyMarkerVendor,
  input: PrSecurityInput,
): 'proven' | 'inferred' | null {
  const branch = input.headRefName ?? '';
  switch (vendor) {
    case 'dependabot': {
      if (input.bodyText.includes(DEPENDABOT_SECURITY_FOOTER)) return 'proven';
      // (b) The ecosystem-named group, when the footer may have been cut off. All three must hold;
      // a COMPLETE body with no footer is a positive statement that this is a version update.
      const eco = ECOSYSTEM_GROUP_TITLE.exec(input.title)?.[1]?.toLowerCase();
      if (!eco) return null;
      const groupBranch = new RegExp(`^dependabot/${eco}/(?:.+/)?${eco}-[0-9a-f]{10}$`, 'i');
      if (!groupBranch.test(branch)) return null;
      return dependabotBodyTruncated(input.title, input.bodyText) ? 'inferred' : null;
    }
    case 'renovate':
      return branch.endsWith('-vulnerability') || /\[security\]\s*$/i.test(input.title)
        ? 'proven'
        : null;
    case 'snyk':
      // `snyk-upgrade-` / `[Snyk] Upgrade …` is Snyk's VERSION upgrade, not a fix. Snyk documents
      // that the branch name cannot be customised, which is why it leads.
      return branch.startsWith('snyk-fix-') ||
        /^\[Snyk\] (Security upgrade|Fix for \d+ vulnerabilit)/.test(input.title)
        ? 'proven'
        : null;
    case 'depfu':
      return /^🚨\s*\[security\]/i.test(input.title) ||
        input.bodyText.includes('Your current dependencies have known security vulnerabilities')
        ? 'proven'
        : null;
    // These tools open PRs ONLY to fix vulnerabilities.
    case 'mend':
    case 'aikido':
    case 'socket':
    case 'frogbot':
    case 'checkmarx':
      return 'proven';
    // pyup's security format is unconfirmed, so nothing is inferred for it; greenkeeper has none.
    case 'pyup':
    case 'greenkeeper':
      return null;
  }
}

/** Where a vendor's own description ends and the upstream release notes begin. LINE-ANCHORED: the
 *  heading of Dependabot's `Release notes` / `Commits` / `Sourced from`, Renovate's and Depfu's
 *  `Release Notes`. ⚠ An unanchored match would cut at Renovate's inline "pygments (changelog)"
 *  table cell and at Depfu's "· Repo · Changelog" link — BEFORE the advisory section each writes.
 *  ⚠ The indent is whitespace WITHIN the line (every line terminator excluded, U+2028/9 included):
 *  `^` already matches at each line start, and a `\s*` that crossed lines made a body of 65,536
 *  blank lines — the PR author's to write — take 4 s inside `persistPr`'s transaction. */
const RELEASE_NOTES_START = /^[^\S\r\n\u2028\u2029]*(?:Release notes|Changelog|Commits|Sourced from)\b/im;

export function classifyPrSecurity(input: PrSecurityInput): PrSecuritySignal {
  const dependencyVendor = markerVendor(input);
  const securityFix = dependencyVendor ? securityFixFor(dependencyVendor, input) : null;
  if (!securityFix) return { dependencyVendor, securityFix: null, advisoryIds: [] };
  const cut = RELEASE_NOTES_START.exec(input.bodyText);
  const ownBody = cut ? input.bodyText.slice(0, cut.index) : input.bodyText;
  const advisoryIds = extractAdvisoryIds(
    [input.title, input.headRefName ?? '', ownBody].join('\n'),
  );
  return { dependencyVendor, securityFix, advisoryIds };
}

// ---------------------------------------------------------------------------------------------
// Comment alert rules (evaluated on read — db/security-alerts.ts)
// ---------------------------------------------------------------------------------------------

export type SecurityAlertSource =
  | 'socket'
  | 'dependency_review'
  | 'endor'
  | 'semgrep'
  | 'code_scanning'
  | 'snyk'
  | 'frogbot'
  | 'checkmarx'
  | 'reviewer';
export type SecurityAlertSurface = 'comment' | 'review' | 'thread';

export interface SecurityAlertRule {
  source: Exclude<SecurityAlertSource, 'reviewer'>;
  surfaces: readonly SecurityAlertSurface[];
  /** Does this login belong to the tool? `null` = any author (the body marker proves automation). */
  author: ((normalizedLogin: string) => boolean) | null;
  /** The tool's OWN comments — the latest identified row per (author, `comment`) decides (D10). */
  identifies: RegExp;
  /** For a tool that keeps MORE THAN ONE sticky comment on a PR: which one this body is. Each is its
   *  own latest row, so one comment can never stand in for another. Absent ⇒ one per author. */
  comment?: (body: string) => string;
  /** Positive: an advisory-bearing alert. ALSO requires ≥1 id from `extractAdvisoryIds`. */
  positive: RegExp;
  /** An "all clear" from the same tool. Any match ⇒ not an alert. */
  negative: RegExp | null;
}

/** Socket's dependency OVERVIEW — its second sticky comment, which names no advisory. It carries
 *  Socket's own `overview-comment` marker; "No dependency changes detected" is its empty state. */
const SOCKET_OVERVIEW = /<!-- overview-comment -->|Review the following changes in direct dependencies|No dependency changes detected/;

/** Each tool's own comment format (u-security-bot-formats.md §4). ⚠ Socket, Dependency Review,
 *  Endor, Snyk and Frogbot EDIT their sticky comments in place, so the negative is read off the
 *  CURRENT body — a resolved alert clears itself on the next walk. The walk never deletes a row,
 *  so the latest row is also what supersedes a comment the tool deleted and posted again. */
export const SECURITY_ALERT_RULES: readonly SecurityAlertRule[] = [
  {
    source: 'socket',
    surfaces: ['comment', 'review'],
    author: (l) => l === 'socket-security',
    identifies: /socket\.dev/,
    // ⚠ TWO sticky comments per PR (36 of 66 real Socket PRs carry both): the alerts report and the
    // overview. Keyed on the author alone, an overview created AFTER the report (erxes, four days
    // later — and created_at never moves, so that order is permanent) was Socket's "current" word
    // and hid a live Critical CVE.
    comment: (b) => (SOCKET_OVERVIEW.test(b) ? 'overview' : 'alerts'),
    // Only the CVE rows. "Obfuscated code", install scripts and malware share the comment and
    // are supply-chain risk, not a known advisory.
    positive: /<strong>(Critical|High|Medium|Low) CVE<\/strong>/,
    negative: /All alerts resolved/,
  },
  {
    source: 'dependency_review',
    surfaces: ['comment'],
    author: (l) => l === 'github-actions',
    identifies: /dependency-review-pr-comment-marker|Dependency Review/,
    positive: /❌\s*\d+\s+vulnerable package/,
    // 349 of 349 real Dependency Review comments are one of these — every one says "vulnerab".
    negative: /✅\s*0 vulnerable package|No vulnerabilities or license issues/,
  },
  {
    source: 'endor',
    surfaces: ['comment', 'review', 'thread'],
    author: (l) => /^endor-labs/.test(l),
    identifies: /ENDOR_LABS_GENERATED_COMMENT|Endor Labs detected/,
    // Endor's AI security REVIEW is a second sticky comment. The two real ones carry neither
    // marker above, but one that did must not become the summary's latest row.
    comment: (b) => (/ENDOR_SECURITY_REVIEW_/.test(b) ? 'security_review' : 'summary'),
    positive: /\bSCA\b|[Vv]ulnerab/,
    // …and never alerts in its own right: findings about code, not advisories.
    negative: /ENDOR_SECURITY_REVIEW_/,
  },
  {
    source: 'semgrep',
    surfaces: ['comment', 'thread'],
    author: (l) => /^semgrep/.test(l),
    identifies: /Semgrep/,
    // Supply Chain only; Semgrep CODE findings (`aws-…` rule ids) are SAST.
    positive: /\bssc-[0-9a-f]{8}-|known [^.]{0,40}vulnerab/,
    negative: null,
  },
  {
    source: 'code_scanning',
    surfaces: ['thread'],
    author: (l) => l === 'github-advanced-security',
    // EVERY GHAS root is identified — CodeQL (CWE), zizmor and Trivy misconfiguration included —
    // so they are CONSUMED here and the `reviewer` fallback never reads them. Only an SCA row
    // (Trivy / OSV-Scanner / Grype via SARIF) is positive.
    identifies: /[\s\S]/,
    positive: /\bVulnerability\s+(CVE-\d{4}-\d{4,}|GHSA-)/,
    negative: null,
  },
  {
    source: 'snyk',
    surfaces: ['comment'],
    author: (l) => /^snyk(-io|-bot)?$/.test(l),
    identifies: /[Ss]nyk/,
    // Only a FAILED check: "incomplete" and "passed" are not alerts (the negative is now a backstop).
    // None of the three real formats names an advisory id, so this rule raises only when one does.
    positive: /Snyk checks have failed/,
    negative: /Snyk checks have passed/,
  },
  {
    source: 'frogbot',
    surfaces: ['comment', 'thread'],
    // Frogbot posts through github-actions or a person's token — attributed by marker, never login.
    author: null,
    identifies: /Frogbot scanned this pull request|FrogbotReviewComment/,
    positive: /Vulnerable Dependencies/,
    negative: null,
  },
  {
    source: 'checkmarx',
    surfaces: ['comment'],
    author: null,
    identifies: /Checkmarx One – Scan Summary/,
    positive: /CVE-/,
    negative: null,
  },
];

/** CodeRabbit's quoted-material `<details>` blocks, named by their summary. Case-sensitive and
 *  word-bounded: the finding's OWN blocks ("Proposed fix") must survive. */
const QUOTED_SUMMARY =
  /\b(?:Learnings|Analysis chain|Supported by static analysis|Web query|Script executed|Additional context|Committable suggestion|Prompt for AI Agents|Tools)\b/;

/** Removes quoted material an AI reviewer embeds in a finding: CodeRabbit `<details><summary>`
 *  blocks whose summary names Learnings / Learnings used / Analysis chain / Supported by static
 *  analysis / Web query / Script executed / Additional context / Committable suggestion / Prompt for
 *  AI Agents / Tools, and `Learnt from:` blocks. Measured: removes the SNYK ids and quoted GHSA ids
 *  web-query citations add, keeps the finding's own CVE.
 *
 *  ⚠ BALANCED, not a lazy regex: CodeRabbit NESTS these (an Analysis chain holds several Script
 *  executed / Web query blocks), and `<details>[\s\S]*?</details>` would stop at the first inner
 *  close and leave the rest of the chain — web-query citations included — in the text. */
export function stripQuotedReviewerBlocks(body: string): string {
  // ⚠ LINEAR ON PURPOSE — the text is an automation's, quoting whatever a PR author wrote. `[^<>]`,
  // not `[^>]`: a `<details` with no `>` scanned to the end of the body from every start (8,192 of
  // them took 0.5 s). The summary capture and the fence's info string below are bounded the same way.
  const tag = /<details\b[^<>]*>|<\/details\s*>/gi;
  let out = '';
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(body)) !== null) {
    if (m[0][1] === '/') continue; // a stray close outside any block we are removing
    // Bounded: an unclosed `<summary>` after each of 3,640 `<details>` scanned to the end every
    // time (95 ms). The longest of 39,088 real summaries is 164 characters.
    const summary = /^\s*<summary\b[^<>]*>([\s\S]{0,1000}?)<\/summary>/i.exec(body.slice(tag.lastIndex));
    if (!summary || !QUOTED_SUMMARY.test(summary[1] ?? '')) continue;
    // Walk to this block's OWN close, counting nested opens.
    let depth = 1;
    let end = body.length;
    let inner: RegExpExecArray | null;
    while ((inner = tag.exec(body)) !== null) {
      depth += inner[0][1] === '/' ? -1 : 1;
      if (depth === 0) {
        end = tag.lastIndex;
        break;
      }
    }
    out += body.slice(from, m.index);
    from = end;
    tag.lastIndex = end;
  }
  out += body.slice(from);
  // `Learnt from:` blocks that sit outside a Learnings summary: a fenced block opening with it,
  // or a bare paragraph (up to the next blank line).
  return out
    .replace(/```[^\n`]*\n\s*Learnt from:[\s\S]*?```/g, '')
    .replace(/^[ \t]*Learnt from:[\s\S]*?(?=\n[ \t]*\n|(?![\s\S]))/gm, '');
}

/** The SQL pre-filter substrings (db/security-alerts.ts). Every rule above needs one of these in its
 *  body. ⚠ The dialects DISAGREE on case: SQLite's `LIKE` ignores ASCII case and Postgres's does not,
 *  so SQLite also returns a lowercase-only `cve-2026-…`. `evaluateSecurityAlerts` re-applies these
 *  literals EXACT-CASE, which makes both dialects alert on the same rows — so the SQL may be looser
 *  than this list, never stricter. */
export const SECURITY_ALERT_PREFILTER: readonly string[] = [
  'CVE-',
  'GHSA-',
  'RUSTSEC-',
  'PYSEC-',
  'GO-20',
  'OSV-',
  'SNYK-',
  'AIKIDO-',
  'ssc-',
  'socket.dev',
  'Dependency Review',
  'dependency-review-pr-comment-marker',
  'ENDOR_LABS_GENERATED_COMMENT',
  'Endor Labs',
  'Semgrep',
  'Snyk',
  'Frogbot',
  'Checkmarx One',
];

export interface AlertCandidateRow {
  surface: SecurityAlertSurface;
  rowId: number;
  prId: number;
  authorId: number | null;
  authorLogin: string | null;
  body: string;
  createdAt: Date;
  /** thread surface only */
  threadId: number | null;
  isRoot: boolean;
  threadResolved: boolean;
  threadState: 'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched' | null;
}

export interface EvaluatedAlert {
  source: SecurityAlertSource;
  surface: SecurityAlertSurface;
  rowId: number;
  prId: number;
  authorId: number;
  threadId: number | null;
  advisoryIds: string[]; // ≤ 5, canonical
  at: Date;
}

/** Ids carried per alert — the card names a few; the full list is the tool's own comment. */
const ALERT_IDS_MAX = 5;

/** Lowercased, `[bot]` suffix stripped — the same normalisation as shared `normalizeBotLogin`,
 *  inlined because this module imports nothing but types. */
function normalizedLogin(login: string | null): string {
  return (login ?? '').toLowerCase().replace(/\[bot\]$/, '');
}

/** Drops markdown blockquote lines. For the two author-free rules only: their body marker is what
 *  proves the tool, and a person quote-replying the tool's report ("> Frogbot scanned this pull
 *  request … CVE-…" then "this is fixed") carries that marker without being the tool. Keyed per
 *  author, such a quote would be its OWN sticky alert — one the tool's next all-clear could never
 *  supersede. Linear: `.` stops at the line's end. */
function withoutBlockquotes(body: string): string {
  return body.replace(/^[ \t]*>.*(?:\n|$)/gm, '');
}

/** A thread finding is live until the thread is resolved or a later commit touched its file. */
function threadLive(row: AlertCandidateRow): boolean {
  return !row.threadResolved && row.threadState !== 'resolved' && row.threadState !== 'likely_addressed';
}

function isLater(a: AlertCandidateRow, b: AlertCandidateRow): boolean {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  return d !== 0 ? d > 0 : a.rowId > b.rowId;
}

/** PURE. For each PR, per rule: comment/review surfaces take the LATEST row (by createdAt, then
 *  rowId) the rule IDENTIFIES from that author — per sticky comment, where `rule.comment` names
 *  several — and alert iff it is positive, not negative and names an id. Thread surfaces take ROOTS
 *  only and alert iff positive, id-bearing and the thread is neither resolved nor
 *  `likely_addressed` / `resolved`. Rows a rule identified are consumed before `reviewer` runs.
 *  Author gating: `rule.author` null ⇒ any author; otherwise the author must be in `automatedIds`
 *  AND match `rule.author`.
 *
 *  A row with no author (a deleted account) never alerts: every alert names who raised it. Nor does
 *  one without an EXACT-CASE pre-filter literal — the rows Postgres's `LIKE` would have returned. */
export function evaluateSecurityAlerts(
  rows: readonly AlertCandidateRow[],
  automatedIds: ReadonlySet<number>,
): Map<number, EvaluatedAlert[]> {
  const byPr = new Map<number, AlertCandidateRow[]>();
  for (const r of rows) {
    if (r.authorId == null) continue;
    if (!SECURITY_ALERT_PREFILTER.some((s) => r.body.includes(s))) continue;
    const list = byPr.get(r.prId);
    if (list) list.push(r);
    else byPr.set(r.prId, [r]);
  }

  const out = new Map<number, EvaluatedAlert[]>();
  for (const [prId, prRows] of byPr) {
    const alerts: EvaluatedAlert[] = [];
    const consumed = new Set<AlertCandidateRow>();
    const emit = (source: SecurityAlertSource, r: AlertCandidateRow, ids: string[]): void => {
      alerts.push({
        source,
        surface: r.surface,
        rowId: r.rowId,
        prId,
        authorId: r.authorId!,
        threadId: r.surface === 'thread' ? r.threadId : null,
        advisoryIds: ids.slice(0, ALERT_IDS_MAX),
        at: r.createdAt,
      });
    };

    for (const rule of SECURITY_ALERT_RULES) {
      // What the rule reads: the body as stored, or — for an author-free rule — without the lines a
      // person quoted (`withoutBlockquotes`), so a quote can neither identify nor alert.
      const textOf = (r: AlertCandidateRow): string =>
        rule.author === null ? withoutBlockquotes(r.body) : r.body;
      const identified = prRows.filter(
        (r) =>
          rule.surfaces.includes(r.surface) &&
          (rule.author === null ||
            (automatedIds.has(r.authorId!) && rule.author(normalizedLogin(r.authorLogin)))) &&
          rule.identifies.test(textOf(r)),
      );
      for (const r of identified) consumed.add(r);

      const verdictIds = (r: AlertCandidateRow): string[] | null => {
        const text = textOf(r);
        if (!rule.positive.test(text) || rule.negative?.test(text)) return null;
        const ids = extractAdvisoryIds(text);
        return ids.length > 0 ? ids : null;
      };

      // Comment / review: the tool's LATEST identified row per author — and per sticky comment — is
      // that comment's current statement.
      const latest = new Map<string, AlertCandidateRow>();
      for (const r of identified) {
        if (r.surface === 'thread') continue;
        const key = `${r.authorId!}:${rule.comment?.(textOf(r)) ?? ''}`;
        const prev = latest.get(key);
        if (!prev || isLater(r, prev)) latest.set(key, r);
      }
      for (const r of latest.values()) {
        const ids = verdictIds(r);
        if (ids) emit(rule.source, r, ids);
      }

      // Threads: each ROOT is its own finding; a reply is never read.
      for (const r of identified) {
        if (r.surface !== 'thread' || !r.isRoot || !threadLive(r)) continue;
        const ids = verdictIds(r);
        if (ids) emit(rule.source, r, ids);
      }
    }

    // `reviewer` — the last resort, THREAD ROOTS only: an automation's own finding naming an
    // advisory once the quoted material it embeds is stripped.
    for (const r of prRows) {
      if (r.surface !== 'thread' || !r.isRoot || consumed.has(r)) continue;
      if (!automatedIds.has(r.authorId!) || !threadLive(r)) continue;
      const ids = extractAdvisoryIds(stripQuotedReviewerBlocks(r.body));
      if (ids.length > 0) emit('reviewer', r, ids);
    }

    if (alerts.length > 0) {
      alerts.sort((a, b) => b.at.getTime() - a.at.getTime() || b.rowId - a.rowId);
      out.set(prId, alerts);
    }
  }
  return out;
}
