// Source guard: every PR write mutation refetches through THE ONE WRITE SET.
//
// `invalidateAfterPrWrite` (hooks/prCacheSync.ts) is the only list of keys a PR write moves. Before
// it, thirteen hooks each hand-picked their own, and the Pending conflicts card outlived the push
// that retired it. A new mutation hook in these files that forgets the helper would reintroduce
// exactly that, and nothing else would fail — so this reads the source.
//
// ⚠ COMMENTS ARE STRIPPED FIRST. A guard that matched the helper's name inside a comment would pass
// a hook that only TALKS about calling it.
//
// Nothing is exempt. `useEnqueueMergeQueue` / `useDequeueMergeQueue` were, until the merge-queue
// work wired them through the helper (they AWAIT it, for spinner continuity — see usePrWrites.ts).
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HELPER = 'invalidateAfterPrWrite(';
const EXEMPT = new Set<string>();

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
}

/** Drop block comments and whole-line / trailing `//` comments (not `://` inside a URL string). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/**
 * Each top-level export → its text up to the next top-level declaration.
 *
 * ⚠ EVERY TOP-LEVEL DECLARATION IS A BOUNDARY, not only `export function`. A hook written as
 * `export const useX = () => useMutation(...)` (or an unexported helper between two hooks) would
 * otherwise be folded into the slice of the function above it, and pass on THAT function's call.
 */
function exportedFunctions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|(?:const|let|var)\s+(\w+)|class\s+(\w+)|(?:interface|type|enum)\s+(\w+))/gm;
  const starts: Array<{ name: string | null; at: number }> = [];
  for (let m = re.exec(src); m != null; m = re.exec(src)) {
    const name = m[2] ?? m[3] ?? m[4] ?? m[5] ?? null;
    // Only EXPORTED values are reported; every declaration still ends the slice before it.
    const exported = m[1] != null && m[5] == null;
    starts.push({ name: exported ? name : null, at: m.index });
  }
  starts.forEach((s, i) => {
    if (s.name == null) return;
    const end = starts[i + 1]?.at ?? src.length;
    out.set(s.name, src.slice(s.at, end));
  });
  return out;
}

/** The hooks in `all` that build a mutation: `useMutation(` or `useMutation<…>(`. */
function mutationHooks(all: Map<string, string>): Array<[string, string]> {
  return [...all].filter(([, body]) => /\buseMutation\s*[<(]/.test(body));
}

function fns(rel: string): Map<string, string> {
  return exportedFunctions(stripComments(source(rel)));
}

describe('every PR write mutation refetches through invalidateAfterPrWrite', () => {
  const files = ['hooks/usePrWrites.ts', 'hooks/useAutoMerge.ts', 'hooks/useCiRerun.ts'];

  for (const rel of files) {
    it(`${rel}: each hook that builds a mutation calls the helper`, () => {
      const all = fns(rel);
      // `useMutation(` or `useMutation<…>(` — a typed call must not slip past the guard.
      const mutations = mutationHooks(all);
      expect(mutations.length).toBeGreaterThan(0);
      for (const [name, body] of mutations) {
        if (EXEMPT.has(name)) continue;
        // `useRequestReviewers` hands its options to useMutation; the options builder is where the
        // success lives.
        const where = name === 'useRequestReviewers' ? all.get('requestReviewersOptions') ?? '' : body;
        expect({ name, calls: where.includes(HELPER) }).toEqual({ name, calls: true });
      }
    });
  }

  it('the exemption list names hooks that still exist (so it cannot rot into a blanket pass)', () => {
    const all = fns('hooks/usePrWrites.ts');
    for (const name of EXEMPT) expect(all.has(name)).toBe(true);
  });

  it('AI Fix: the push refetches the write set', () => {
    expect(fns('hooks/useAiFix.ts').get('usePushFix')).toContain(HELPER);
  });

  it('the conflict commit refetches the write set when the stream says done', () => {
    const all = fns('hooks/useConflictCommit.ts');
    expect(all.get('invalidateAfterConflictCommit')).toContain(HELPER);
    expect(all.get('useConflictCommitInvalidation')).toContain('invalidateAfterConflictCommit(');
  });

  it('the bot-thread resolves and the Claude Review posts refetch the write set', () => {
    expect(fns('hooks/useBotTriage.ts').get('useScopeResolveBotThreads')).toContain(HELPER);
    const claude = fns('hooks/useClaudeReview.ts');
    expect(claude.get('usePostFinding')).toContain(HELPER);
    expect(claude.get('usePostReview')).toContain(HELPER);
  });

  it('the resolver shell refetches the write set again when it closes after a push', () => {
    const shell = stripComments(source('components/conflicts/ConflictResolverOverlay.tsx'));
    expect(shell).toContain(HELPER);
    expect(shell).toContain('usePrLiveRefresh(');
    // "A push may have landed" is the ONE store fold, fed the mutation (so a POST still on the
    // wire counts), and it gates the reason every way out files and the head-moved warning.
    expect(shell).toMatch(/pushMayHaveLanded\(\s*commit\s*,\s*commitMutation\s*\)/);
    expect(shell).toContain('closeReasonAfterPush(');
    expect(shell).toMatch(/useHeadMoved\([^;]*\)\s*&&\s*!pushSent/);
    // Every close the shell files either goes through `closeReason(…)` or is the landing step's
    // own verdict — a bare `'user'` would offer the "nothing pushed" toast after a push.
    const closes = shell.match(/close\(\{\s*reason:\s*[^}]*\}\)/g) ?? [];
    expect(closes.length).toBeGreaterThan(0);
    for (const c of closes) {
      expect(c).toMatch(/closeReason\(|committedNow \? 'committed'/);
    }
  });

  it('an auto-merge landing refetches the write set as a merge', () => {
    const banner = stripComments(source('components/AutoMergeBanner.tsx'));
    expect(banner).toMatch(/invalidateAfterPrWrite\([^)]*\{\s*merged:\s*true\s*\}/);
  });
});

describe('the guard itself', () => {
  it('slices a const-arrow hook on its own, so it cannot pass on its neighbour\'s call', () => {
    const src = [
      'export function useA() {',
      '  return useMutation({ onSuccess: () => void invalidateAfterPrWrite(qc, 1) });',
      '}',
      'export const useB = () => useMutation({ onSuccess: () => {} });',
      'const helper = 1;',
      'export default function useC() {',
      '  return useMutation<void, Error, void>({ mutationFn: async () => {} });',
      '}',
    ].join('\n');
    const hooks = new Map(mutationHooks(exportedFunctions(src)));
    expect([...hooks.keys()]).toEqual(['useA', 'useB', 'useC']);
    expect(hooks.get('useA')).toContain(HELPER);
    expect(hooks.get('useB')).not.toContain(HELPER);
    expect(hooks.get('useC')).not.toContain(HELPER);
  });

  it('does not count a helper name that only appears in a comment', () => {
    const src = stripComments(
      ['export function useD() {', '  // invalidateAfterPrWrite(qc, 1)', '  return useMutation({});', '}'].join('\n'),
    );
    expect(exportedFunctions(src).get('useD')).not.toContain(HELPER);
  });
});
