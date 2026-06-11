import { describe, expect, it } from 'vitest';
import { analyzeDiff, decideReviewMode, type RoutingThresholds } from './routing.js';

// Fixed thresholds so the tests don't depend on env (mirror config defaults).
const T: RoutingThresholds = {
  maxFiles: 5,
  maxLines: 150,
  maxDirs: 2,
  maxSubsystems: 1,
};

// Build one file segment of a unified diff. `addLines`/`delLines` default to benign
// lowercase content that trips no export marker.
function fileSeg(
  path: string,
  opts: {
    add?: number;
    del?: number;
    newFile?: boolean;
    addLines?: string[];
    delLines?: string[];
  } = {},
): string {
  const add =
    opts.addLines ?? Array.from({ length: opts.add ?? 0 }, (_, i) => `call_a${i}();`);
  const del =
    opts.delLines ?? Array.from({ length: opts.del ?? 0 }, (_, i) => `call_d${i}();`);
  const lines = [`diff --git a/${path} b/${path}`];
  if (opts.newFile) lines.push('new file mode 100644');
  lines.push('index 1111111..2222222 100644');
  lines.push(opts.newFile ? '--- /dev/null' : `--- a/${path}`);
  lines.push(`+++ b/${path}`);
  lines.push(`@@ -1,${Math.max(del.length, 1)} +1,${Math.max(add.length, 1)} @@`);
  for (const d of del) lines.push(`-${d}`);
  for (const a of add) lines.push(`+${a}`);
  return lines.join('\n');
}

const diff = (...segs: string[]): string => segs.join('\n');

describe('analyzeDiff', () => {
  it('counts additions/deletions and ignores headers', () => {
    const files = analyzeDiff(fileSeg('src/app/foo.ts', { add: 2, del: 1 }));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/app/foo.ts',
      additions: 2,
      deletions: 1,
      isNew: false,
      apiTouch: false,
    });
  });

  it('flags a brand-new file', () => {
    const [f] = analyzeDiff(fileSeg('src/app/new.ts', { add: 3, newFile: true }));
    expect(f).toMatchObject({ isNew: true, additions: 3, deletions: 0 });
  });

  it('detects an exported-symbol change on a removed line', () => {
    const [f] = analyzeDiff(
      fileSeg('src/app/api.ts', {
        delLines: ['export function foo(a: number) {'],
        addLines: ['export function foo(a: number, b: number) {'],
      }),
    );
    expect(f?.apiTouch).toBe(true);
  });

  it('does NOT flag a new exported symbol (addition-only)', () => {
    const [f] = analyzeDiff(
      fileSeg('src/app/api.ts', { addLines: ['export function brandNew() {}'] }),
    );
    expect(f?.apiTouch).toBe(false);
  });

  it('detects a contract-definition path (.proto)', () => {
    const [f] = analyzeDiff(fileSeg('api/user.proto', { add: 1 }));
    expect(f?.apiTouch).toBe(true);
  });

  it('detects an exported Go method change (receiver before the name)', () => {
    const [f] = analyzeDiff(
      fileSeg('server/http.go', {
        delLines: ['func (s *Server) Handle(w int) {'],
        addLines: ['func (s *Server) Handle(w int, r int) {'],
      }),
    );
    expect(f?.apiTouch).toBe(true);
  });

  it('counts hunk-body lines whose source text begins with "-- " / "++ "', () => {
    // These render in the diff as `--- ...` / `+++ ...` (marker + content) and must
    // NOT be mistaken for the file headers — the load-bearing regression.
    const [f] = analyzeDiff(
      fileSeg('db/schema.sql', {
        delLines: ['-- old comment', '-- another removed comment'],
        addLines: ['++ weird added content'],
      }),
    );
    expect(f).toMatchObject({ additions: 1, deletions: 2 });
  });
});

describe('decideReviewMode (auto)', () => {
  const auto = (d: string) =>
    decideReviewMode({ diff: d, requested: 'auto', thresholds: T });

  it('routes a small localized change to diff_only', () => {
    const res = auto(fileSeg('src/app/foo.ts', { add: 4, del: 2 }));
    expect(res.mode).toBe('diff_only');
    expect(res.reason).toMatchObject({
      decidedBy: 'router',
      trippedBy: null,
      changedFiles: 1,
      linesChanged: 6,
      dirsTouched: 1,
      subsystems: 1,
      apiTouch: false,
    });
  });

  it('skips an empty (all-noise) diff', () => {
    expect(auto('').mode).toBe('skip');
  });

  it('skips a rename/mode-only change (no textual lines)', () => {
    const renameOnly = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ].join('\n');
    expect(auto(renameOnly).mode).toBe('skip');
  });

  it('routes to worktree when too many files change', () => {
    const res = auto(
      diff(
        ...Array.from({ length: 6 }, (_, i) =>
          fileSeg(`src/app/f${i}.ts`, { add: 1 }),
        ),
      ),
    );
    expect(res.mode).toBe('worktree');
    expect(res.reason.trippedBy).toBe('files');
  });

  it('routes to worktree on an exported-signature change (apiTouch)', () => {
    const res = auto(
      fileSeg('src/app/api.ts', {
        delLines: ['export function foo() {'],
        addLines: ['export function foo(x: number) {'],
      }),
    );
    expect(res.mode).toBe('worktree');
    expect(res.reason.trippedBy).toBe('apiTouch');
  });

  it('routes to worktree on a contract-definition path', () => {
    const res = auto(fileSeg('api/user.proto', { add: 2, del: 1 }));
    expect(res.mode).toBe('worktree');
    expect(res.reason.trippedBy).toBe('apiTouch');
  });

  it('routes to worktree when spanning too many directories', () => {
    const res = auto(
      diff(
        fileSeg('src/a/x.ts', { add: 1 }),
        fileSeg('src/b/y.ts', { add: 1 }),
        fileSeg('src/c/z.ts', { add: 1 }),
      ),
    );
    expect(res.mode).toBe('worktree');
    expect(res.reason.trippedBy).toBe('dirs');
  });

  it('routes to worktree when spanning multiple subsystems', () => {
    const res = auto(
      diff(fileSeg('src/x.ts', { add: 1 }), fileSeg('lib/y.ts', { add: 1 })),
    );
    expect(res.mode).toBe('worktree');
    expect(res.reason.trippedBy).toBe('subsystems');
  });

  it('routes to worktree on a large churn', () => {
    const res = auto(fileSeg('src/app/big.ts', { add: 200 }));
    expect(res.mode).toBe('worktree');
    expect(res.reason.trippedBy).toBe('lines');
  });

  it('does NOT under-route a large "-- "-comment deletion (the maxLines gate still trips)', () => {
    const res = auto(
      fileSeg('db/schema.sql', {
        delLines: Array.from({ length: 200 }, (_, i) => `-- removed line ${i}`),
      }),
    );
    expect(res.reason.linesChanged).toBe(200);
    expect(res.mode).toBe('worktree');
    expect(res.reason.trippedBy).toBe('lines');
  });
});

describe('decideReviewMode (forced override)', () => {
  it('honours a forced diff_only on a large diff', () => {
    const big = diff(
      ...Array.from({ length: 8 }, (_, i) => fileSeg(`src/app/f${i}.ts`, { add: 5 })),
    );
    const res = decideReviewMode({ diff: big, requested: 'diff_only', thresholds: T });
    expect(res.mode).toBe('diff_only');
    expect(res.reason.decidedBy).toBe('user');
    expect(res.reason.changedFiles).toBe(8); // metrics still recorded
  });

  it('honours a forced worktree on a tiny diff', () => {
    const res = decideReviewMode({
      diff: fileSeg('src/app/foo.ts', { add: 1 }),
      requested: 'worktree',
      thresholds: T,
    });
    expect(res.mode).toBe('worktree');
    expect(res.reason.decidedBy).toBe('user');
  });
});
