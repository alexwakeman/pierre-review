// ROBOTS.TXT FOR A CRAWL (docs/REFERENCE-DOCS.md § Following links). One fetch per crawl, through the
// same guarded `fetchPage` as every page; a site with no robots.txt, an error, or a body that is not
// text allows everything (RFC 9309 § 2.3.1.3: a 4xx file means "no rules"); an UNREACHABLE one (5xx,
// timeout, network failure) means "disallow everything" (§ 2.3.1.4) — `DISALLOW_ALL`, chosen in crawl.ts.
//
//   • the group for `limn` wins over `*` (a product token, case-insensitive, as RFC 9309 matches it);
//     several groups naming the same agent are merged;
//   • Allow / Disallow by LONGEST match against path + query; a tie goes to Allow; `*` matches any
//     run of characters and a trailing `$` anchors the end; an empty Disallow allows everything;
//   • `Crawl-delay` (not in the RFC, but widely written) is honoured up to ROBOTS_MAX_DELAY_MS.

export const ROBOTS_AGENT = 'limn';
export const ROBOTS_MAX_DELAY_MS = 5_000;
/** Read at most this much of a robots.txt (RFC 9309 asks crawlers to read at least 500 KiB). */
export const ROBOTS_MAX_BYTES = 512 * 1024;

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  rules: Rule[];
  /** Milliseconds, already capped; null when the file names none. */
  crawlDelayMs: number | null;
}

export const ALLOW_ALL: RobotsRules = { rules: [], crawlDelayMs: null };
export const DISALLOW_ALL: RobotsRules = { rules: [{ allow: false, pattern: '/' }], crawlDelayMs: null };

interface Group {
  agents: string[];
  rules: Rule[];
  delay: number | null;
}

export function parseRobots(text: string, agent: string = ROBOTS_AGENT): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  let rulesKept = 0;
  for (const rawLine of text.slice(0, ROBOTS_MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // a rule before any user-agent line belongs to no group
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // "Disallow:" with nothing = allow all
      if (value === '') continue;
      if (rulesKept >= ROBOTS_MAX_RULES) continue;
      rulesKept++;
      current.rules.push({ allow: key === 'allow', pattern: value.replace(/\*+/g, '*').slice(0, ROBOTS_MAX_PATTERN) });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  const token = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a === token));
  const picked = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  const delays = picked.map((g) => g.delay).filter((d): d is number => d != null);
  return {
    rules: picked.flatMap((g) => g.rules),
    crawlDelayMs: delays.length > 0 ? Math.min(ROBOTS_MAX_DELAY_MS, Math.round(Math.max(...delays) * 1000)) : null,
  };
}

/** At most this many rules are kept from one robots.txt, and each pattern is cut to this length. */
export const ROBOTS_MAX_RULES = 2_000;
export const ROBOTS_MAX_PATTERN = 512;

/**
 * Does a robots pattern match the start of `target` (the whole of it when the pattern ends in `$`)?
 * A LINEAR-TIME glob match, never a RegExp: the pattern and the path are both untrusted, and a
 * backtracking `.*a.*a.*b` against a long path stalls the event loop for seconds. The two-pointer
 * walk only ever backtracks to the most recent `*`, so it is O(pattern x path) at worst.
 */
export function robotsPatternMatches(rawPattern: string, target: string): boolean {
  const anchored = rawPattern.endsWith('$');
  let pat = (anchored ? rawPattern.slice(0, -1) : rawPattern).replace(/\*+/g, '*');
  if (!anchored) pat += '*'; // an unanchored pattern is a prefix match
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < target.length) {
    if (p < pat.length && pat[p] === '*') {
      starP = p++;
      starT = t;
    } else if (p < pat.length && pat[p] === target[t]) {
      p++;
      t++;
    } else if (starP >= 0) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

/** Percent-decode what is safe to decode, so `/a%2Db` and `/a-b` compare alike (RFC 9309 § 2.2.2). */
function canon(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (whole, hex: string) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : whole.toUpperCase();
  });
}

/** May a robot read this path (path + query, starting with `/`)? */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  const target = canon(pathAndQuery || '/');
  let best: { len: number; allow: boolean } | null = null;
  for (const r of rules.rules) {
    if (!robotsPatternMatches(canon(r.pattern), target)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}
