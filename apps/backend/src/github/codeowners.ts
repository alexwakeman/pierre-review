// CODEOWNERS-based reviewer suggestions (CORE). Fetches a repo's CODEOWNERS file via the
// contents API, parses it, and — given a PR's changed paths — returns the owning users +
// teams. Best-effort throughout: any failure (no file, token can't read the repo, a parse
// hiccup) degrades to "no CODEOWNERS suggestions", NEVER an error on the PR-detail path.
//
// Why CODEOWNERS and not the org/teams API: the contents API is reachable in every auth
// mode (local gh token, cloud OAuth `public_repo`, GitHub App with contents:read), and a
// `@org/team` owner is directly requestable as a review via `team_reviewers` — no need to
// expand team membership (which needs `read:org` + org membership and is unreliable under
// the cloud GitHub App). Individual `@user` owners become user suggestions directly.
import { ghRestGetContentRaw } from './client.js';

// A parsed CODEOWNERS rule: a compiled matcher + the owner tokens on that line.
interface CodeownersRule {
  re: RegExp;
  // Raw owner tokens, e.g. '@octocat' or '@acme/backend' (emails are dropped at parse).
  owners: string[];
}

// What matching a PR's files against CODEOWNERS yields.
export interface CodeownersMatch {
  logins: string[]; // individual @user owners (deduped, '@' stripped)
  teams: { slug: string; name: string }[]; // @org/team owners (name = 'org/team', slug = 'team')
}

// The candidate file locations GitHub honours, in the order it resolves them.
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

// Per-(account, repo) cache. CODEOWNERS changes rarely, so a short TTL keeps the extra
// contents-API call off the hot path while staying reasonably fresh. A `null` rules value
// is cached too (the common "repo has no CODEOWNERS" case) so we don't refetch a 404 on
// every PR open. Keyed by account so one tenant's token result never leaks to another.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, { rules: CodeownersRule[] | null; at: number }>();

// ---- Hard limits on attacker-supplied input ----
// A CODEOWNERS file is fetched from a repository, which means its contents are chosen by
// whoever controls that repository — in cloud, anyone who can sign up and add their own
// repo. Every one of these rules is then regex-matched against every changed path of every
// PR on the request thread of a SINGLE-threaded server, so unbounded input here is a
// denial-of-service on the whole deployment, not just on the caller.
//
// A real CODEOWNERS file is a few dozen lines; GitHub itself stops honouring one past 3 MB
// and only applies the first 1000 rules. These caps sit comfortably above any legitimate
// file and turn a hostile one into a truncated, harmless one.
const MAX_CODEOWNERS_BYTES = 256 * 1024;
const MAX_RULES = 500;
const MAX_PATTERN_LENGTH = 512;
/** Cap the paths matched per PR. A PR touching more files than this is already an outlier,
 *  and suggestions from the first N are as useful as suggestions from all of them. */
const MAX_PATHS_MATCHED = 300;

// Convert a CODEOWNERS (gitignore-style) path pattern into a regex over POSIX file paths.
// A best-effort subset matching GitHub's documented CODEOWNERS semantics: `*` matches
// within a single segment (NOT across `/`), `**` across segments, `?` one non-slash char;
// a leading `/` or any internal `/` anchors to the repo root, otherwise the pattern may
// match at any directory depth; a trailing `/` (or a bare directory name) owns everything
// under that directory. Exported for the unit test that locks these semantics.
export function globToRegExp(raw: string): RegExp {
  let p = raw.trim();
  if (p.length > MAX_PATTERN_LENGTH) {
    throw new Error('codeowners pattern too long');
  }
  // ---- ReDoS guard: collapse repeated globs BEFORE compiling ----
  // Each segment-aligned `**/` compiles to `(?:.*/)?` below. Two of those in a row give the
  // regex engine two nullable, overlapping ways to consume the same directory prefix, and
  // N in a row make that 2^N — so `**/**/**/…/zzz.txt` against a deep path backtracks
  // effectively forever, freezing the event loop for every tenant.
  //
  // Collapsing is not merely a mitigation, it is SEMANTICALLY EXACT: "any number of leading
  // directories, then any number of leading directories" is the same language as "any
  // number of leading directories". Same for a run of bare `**`, and for `**` adjacent to
  // `*`. After this, at most one `(?:.*/)?` can come from each distinct run, so the compiled
  // pattern is linear to match.
  p = p
    // `**/**/` … → `**/`
    .replace(/(?:\*\*\/)+/g, '**/')
    // `****…` (a run of 3+ stars, or `**` next to `*`) → `**`
    .replace(/\*{3,}/g, '**')
    // `**/**` (trailing, not slash-terminated) → `**`
    .replace(/\*\*(?:\/\*\*)+/g, '**');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const startSlash = p.startsWith('/');
  if (startSlash) p = p.slice(1);
  // Git: a pattern with a slash anywhere but the end is relative to the root (anchored);
  // a pattern with no internal slash matches by name at any level.
  const anchored = startSlash || p.includes('/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` spans path segments. A segment-aligned `**/` becomes OPTIONAL leading
        // directories that preserve the `/` boundary (so `**/logs` matches `a/logs` but
        // NOT `mylogs`); a trailing/standalone `**` matches anything.
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2; // consume the second '*' and the '/'
        } else {
          re += '.*';
          i += 1; // consume the second '*'
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  // A trailing-slash directory (or a bare literal path) OWNS everything under it, so it
  // gets a "…/.*" / "(?:/.*)?" tail. A wildcard-TERMINATED pattern (e.g. `docs/*`) is
  // single-level per GitHub — it must NOT gain that tail, or it would over-match nested
  // files (`docs/*` matches `docs/a.md` but not `docs/sub/a.md`).
  const endsWithWildcard = /[*?]$/.test(p);
  const body = dirOnly ? `${re}/.*` : endsWithWildcard ? re : `${re}(?:/.*)?`;
  const full = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  // Last line of defence: refuse a compiled source that still contains several nullable
  // `(?:.*/)?` groups. The collapse above should make this unreachable for any input, so
  // reaching it means a pattern shape we did not anticipate — drop the rule (parseCodeowners
  // catches this) rather than hand the engine something that might backtrack.
  const nullableGroups = (full.match(/\(\?:\.\*\/\)\?/g) ?? []).length;
  if (nullableGroups > 2) {
    throw new Error('codeowners pattern too ambiguous to match safely');
  }
  return new RegExp(full);
}

// Parse CODEOWNERS text into ordered rules (order matters: the LAST matching rule wins).
function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const line of text.split('\n')) {
    // Stop at MAX_RULES rather than compiling a hostile 100k-line file. GitHub itself only
    // honours the first 1000 rules, so truncating is consistent with the real semantics.
    if (rules.length >= MAX_RULES) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Strip an inline comment, then split on whitespace: first token = pattern, rest = owners.
    const noComment = trimmed.split('#')[0]!.trim();
    if (!noComment) continue;
    const parts = noComment.split(/\s+/);
    const pattern = parts[0]!;
    // Owners are the @-prefixed tokens (drop bare emails — not requestable as reviewers).
    const owners = parts.slice(1).filter((o) => o.startsWith('@'));
    if (owners.length === 0) continue;
    try {
      rules.push({ re: globToRegExp(pattern), owners });
    } catch {
      /* skip an un-compilable pattern rather than fail the whole file */
    }
  }
  return rules;
}

// Fetch + parse a repo's CODEOWNERS (cached). Returns null when there's no file / it can't
// be read. Never throws.
async function loadRules(
  token: string,
  owner: string,
  name: string,
  accountId: number,
): Promise<CodeownersRule[] | null> {
  const key = `${accountId}:${owner}/${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rules;

  let rules: CodeownersRule[] | null = null;
  try {
    for (const path of CODEOWNERS_PATHS) {
      const res = await ghRestGetContentRaw(
        token,
        `/repos/${owner}/${name}/contents/${path}`,
      );
      if (res.ok && res.text) {
        // Truncate before parsing: the body length is chosen by whoever owns the repo.
        rules = parseCodeowners(
          res.text.length > MAX_CODEOWNERS_BYTES
            ? res.text.slice(0, MAX_CODEOWNERS_BYTES)
            : res.text,
        );
        break;
      }
      // Any non-404 (403 org wall / 401) also means "give up on CODEOWNERS" — stop trying.
      if (res.status !== 404) break;
    }
  } catch {
    rules = null;
  }
  cache.set(key, { rules, at: Date.now() });
  return rules;
}

// Given a PR's changed paths, return the CODEOWNERS-derived owners (users + teams). The
// LAST matching rule for each file wins (git semantics); owners are unioned across files.
export async function getCodeownersMatch(
  token: string,
  owner: string,
  name: string,
  accountId: number,
  changedPaths: string[],
): Promise<CodeownersMatch> {
  const empty: CodeownersMatch = { logins: [], teams: [] };
  if (changedPaths.length === 0) return empty;
  const rules = await loadRules(token, owner, name, accountId);
  if (!rules || rules.length === 0) return empty;

  // Bound the total match work to MAX_PATHS_MATCHED × MAX_RULES regex tests. Both factors
  // are attacker-influenceable (the PR's file count and the repo's CODEOWNERS), and this runs
  // synchronously on the request thread of a single-threaded server.
  const paths =
    changedPaths.length > MAX_PATHS_MATCHED
      ? changedPaths.slice(0, MAX_PATHS_MATCHED)
      : changedPaths;

  const ownerTokens = new Set<string>();
  for (const path of paths) {
    let last: CodeownersRule | null = null;
    for (const r of rules) if (r.re.test(path)) last = r; // last match wins
    if (last) for (const o of last.owners) ownerTokens.add(o);
  }

  const logins: string[] = [];
  const teams: { slug: string; name: string }[] = [];
  for (const tok of ownerTokens) {
    const handle = tok.slice(1); // drop '@'
    if (handle.includes('/')) {
      const slug = handle.slice(handle.indexOf('/') + 1);
      if (slug) teams.push({ slug, name: handle });
    } else if (handle) {
      logins.push(handle);
    }
  }
  return { logins, teams };
}
