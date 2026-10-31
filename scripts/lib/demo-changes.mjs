// WHICH RECORDER STEPS A CHANGE TOUCHES — `pnpm demo:record --changed` (scripts/record-demo.mjs).
//
// Given the changed files (git diff against a base, plus the working tree), answers either "a FULL
// record" with the reason, or the set of step names to re-record. It never guesses in the cheap
// direction: a file it cannot place forces a full record.
//
//   • FULL_RECORD_PATHS (record-demo-steps.mjs) — the seed, schema, migrations, shared wire types,
//     the SPA's data layer, the recorder itself → full.
//   • NO_RECORD_PATHS — tests, docs, the website, the demo replayer → nothing.
//   • A BACKEND source file → the route files that import it (walking imports upward, stopping at a
//     route file) → the /api paths those routes register → for each answer recorded on one of those
//     paths, the FIRST step that recorded it (recording-steps.json). ⚠ That refreshes every answer
//     the change can alter; it does not find a request a view starts making BECAUSE an answer changed
//     (a longer list whose new rows the SPA then fetches): run a full record for that. A file the demo SEEDER imports → full (it changes the
//     data). A file no route reaches (the scheduler, sync) → nothing: the recorder's backend runs
//     no scheduler and no sync.
//   • A FRONTEND source file → the COVERAGE row that names it, plus the rows of every view that
//     renders it (its importers, walked up to the first file a row names) → their steps. No row for
//     the file, or an importer chain that reaches the app shell through files no row names → full.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

/** `*` (one segment), `**` (any depth), `?`, and one level of `{a,b}`. Whole-path match. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',');
      re += `(?:${alts.map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Changed files relative to the repo root: `base...HEAD` (when a base is given) plus the working tree. */
export function changedFiles(root, base) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const files = new Set();
  if (base) for (const f of git(['diff', '--name-only', `${base}...HEAD`])) files.add(f);
  for (const f of git(['diff', '--name-only', 'HEAD'])) files.add(f);
  for (const f of git(['ls-files', '--others', '--exclude-standard'])) files.add(f);
  return [...files].sort();
}

// ── The backend's import graph ──────────────────────────────────────────────────────────────────
function walkTs(dir, out, ext = /\.(ts|mjs)$/) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, out, ext);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const API_LITERAL_RE = /['"`](\/api\/[^'"`\s]*)['"`]/g;

function buildBackendGraph(root) {
  const files = [...walkTs(join(root, 'apps/backend/src'), []), ...walkTs(join(root, 'apps/backend/scripts'), [])];
  const importers = new Map(); // file → Set(files importing it)
  const routes = new Map(); // route file → [/api path patterns]
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      let target = resolve(dirname(f), m[1]);
      if (target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
      else if (!/\.(ts|mjs)$/.test(target)) target += existsSync(`${target}.ts`) ? '.ts' : '/index.ts';
      const rel = relative(root, target);
      if (!importers.has(rel)) importers.set(rel, new Set());
      importers.get(rel).add(relative(root, f));
    }
    if (/FastifyInstance/.test(src) && f.includes('/src/')) {
      const paths = [...src.matchAll(API_LITERAL_RE)].map((m) => m[1]);
      if (paths.length) routes.set(relative(root, f), [...new Set(paths)]);
    }
  }
  return { importers, routes };
}

/** The SPA's import graph: file → the files importing it (relative to root; `.js` specifiers → .ts/.tsx). */
function buildFrontendImporters(root) {
  const importers = new Map();
  for (const f of walkTs(join(root, 'apps/frontend/src'), [], /\.(ts|tsx)$/)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const raw = resolve(dirname(f), m[1]);
      const stem = raw.replace(/\.(js|jsx|ts|tsx)$/, '');
      const target = [`${stem}.tsx`, `${stem}.ts`, join(stem, 'index.tsx'), join(stem, 'index.ts')].find((t) => existsSync(t));
      if (!target) continue;
      const rel = relative(root, target);
      if (!importers.has(rel)) importers.set(rel, new Set());
      importers.get(rel).add(relative(root, f));
    }
  }
  return importers;
}

/** The files that MOUNT views (by URL): a view a row names, mounted here, is covered by that row. */
const VIEW_HOSTS = ['apps/frontend/src/App.tsx', 'apps/frontend/src/main.tsx', 'apps/frontend/src/components/Activity/index.tsx'];

/**
 * A frontend file's steps: its own COVERAGE rows, plus — walking UP its importers — the rows of every
 * view that renders it (a shared component such as CommentCard renders in the Feed, Pending, Bots and
 * PR detail alike). It walks every importer up to the files that mount views (VIEW_HOSTS), adding
 * each file's rows on the way. A file a row names may be mounted there (it is that view); a file NO
 * row names that is mounted there (the shell: top bar, sidebar), or that nothing imports, is in every
 * view or in none we know → null (a full record).
 */
function frontendRows(f, map, importers) {
  const rowsOf = (file) => map.COVERAGE.filter((r) => matchesAny(file, r.files));
  const rows = new Set(rowsOf(f));
  const seen = new Set([f]);
  const queue = [f];
  while (queue.length) {
    const cur = queue.shift();
    const own = rowsOf(cur);
    for (const r of own) rows.add(r);
    const ups = [...(importers.get(cur) ?? [])].filter((u) => !matchesAny(u, map.NO_RECORD_PATHS));
    const named = own.length > 0;
    if (!ups.length && !named) return { rows: null, via: cur };
    for (const u of ups) {
      if (VIEW_HOSTS.includes(u)) {
        if (!named) return { rows: null, via: cur };
        continue;
      }
      if (!seen.has(u)) {
        seen.add(u);
        queue.push(u);
      }
    }
  }
  return { rows: [...rows], via: null };
}

/** A registered route pattern (`/api/prs/:id/files`) as a pathname matcher. */
function routeMatcher(pattern) {
  const re = pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.+*?^$()|[\]\\{}]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${re}$`);
}

/**
 * The verdict for a set of changed files.
 * @param {string} root repo root
 * @param {string[]} files changed paths, relative to root
 * @param {{ FULL_RECORD_PATHS: string[], NO_RECORD_PATHS: string[], COVERAGE: {files: string[], steps: string[]}[] }} map
 * @param {{ keys: Record<string, string[]> } | null} index recording-steps.json (key → steps that recorded it)
 * @param {string[]} stepNames every (expanded) step name, in order
 * @returns {{ full: string | null, steps: Set<string>, why: string[] }}
 */
export function stepsForChanges(root, files, map, index, stepNames) {
  const why = [];
  const steps = new Set();
  const stepGlob = (g) => {
    const re = globToRegExp(g);
    const hit = stepNames.filter((n) => re.test(n));
    for (const n of hit) steps.add(n);
    return hit.length;
  };
  let graph = null;
  let feImporters = null;
  for (const f of files) {
    if (matchesAny(f, map.FULL_RECORD_PATHS)) return { full: `${f} changes what every view reads`, steps, why };
    if (matchesAny(f, map.NO_RECORD_PATHS)) {
      why.push(`${f}: nothing to re-record`);
      continue;
    }
    if (f.startsWith('apps/frontend/src/')) {
      if (!map.COVERAGE.some((r) => matchesAny(f, r.files))) return { full: `${f} is not in COVERAGE (record-demo-steps.mjs)`, steps, why };
      feImporters ??= buildFrontendImporters(root);
      const { rows, via } = frontendRows(f, map, feImporters);
      if (!rows) return { full: `${f} renders through ${via}, which no COVERAGE row names`, steps, why };
      const n = rows.reduce((acc, r) => acc + r.steps.reduce((a, g) => a + stepGlob(g), 0), 0);
      why.push(`${f} → ${rows.flatMap((r) => r.steps).join(', ')} (${n} steps)`);
      continue;
    }
    if (f.startsWith('apps/backend/src/')) {
      if (!index) return { full: `${f} changed and there is no recording-steps.json to map it with`, steps, why };
      graph ??= buildBackendGraph(root);
      // Walk importers upward, stopping at route files.
      const hitRoutes = new Set();
      const seen = new Set([f]);
      const queue = [f];
      let seeder = null;
      while (queue.length) {
        const cur = queue.shift();
        if (graph.routes.has(cur)) {
          hitRoutes.add(cur);
          continue;
        }
        if (/^apps\/backend\/scripts\/seed-demo/.test(cur)) {
          seeder = cur;
          break;
        }
        for (const imp of graph.importers.get(cur) ?? []) {
          if (!seen.has(imp)) {
            seen.add(imp);
            queue.push(imp);
          }
        }
      }
      if (seeder) return { full: `${f} is used by the demo seeder (${seeder})`, steps, why };
      if (!hitRoutes.size) {
        why.push(`${f}: no route reaches it (nothing to re-record)`);
        continue;
      }
      // A server answer is the same whichever step asked for it, so ONE step per answer is enough: the
      // first that recorded it (the steps index lists captors in declared order).
      const matchers = [...hitRoutes].flatMap((r) => graph.routes.get(r).map(routeMatcher));
      let n = 0;
      const before = steps.size;
      for (const [key, captors] of Object.entries(index.keys)) {
        const pathname = key.slice(key.indexOf(' ') + 1).split('?')[0];
        if (captors.length && matchers.some((m) => m.test(pathname))) {
          n++;
          steps.add(captors[0]);
        }
      }
      why.push(`${f} → ${hitRoutes.size} route file(s) → ${n} recorded answers → ${steps.size - before} more step(s)`);
      continue;
    }
    // Anything else in the repo (another package, a root config): be safe.
    return { full: `${f} is outside the mapped areas`, steps, why };
  }
  return { full: null, steps, why };
}
