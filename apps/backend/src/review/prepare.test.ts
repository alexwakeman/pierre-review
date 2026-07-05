import { describe, expect, it } from 'vitest';
import { analyzeDiff, isNoiseFile } from './prepare.js';

// analyzeDiff moved here from review/routing.ts when Claude Review's product layer went to
// @pierre/pro (the mode-routing decision that consumes these metrics lives in the plugin;
// the diff analysis stays core so run-time + post-time anchoring share one diff pass).

describe('analyzeDiff', () => {
  it('counts additions/deletions per file', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;`;
    const [f] = analyzeDiff(diff);
    expect(f).toMatchObject({ path: 'src/foo.ts', additions: 2, deletions: 1, isNew: false });
  });

  it('detects a brand-new file and does NOT flag apiTouch for an ADDED export', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+const y = 2;`;
    const [f] = analyzeDiff(diff);
    expect(f).toMatchObject({ isNew: true, additions: 2, deletions: 0, apiTouch: false });
  });

  it('flags apiTouch when a REMOVED line changes an exported symbol', () => {
    const diff = `diff --git a/api.ts b/api.ts
--- a/api.ts
+++ b/api.ts
@@ -1,2 +1,2 @@
-export function foo() {}
+function foo() {}`;
    expect(analyzeDiff(diff)[0]?.apiTouch).toBe(true);
  });

  it('flags apiTouch by contract PATH (.d.ts) regardless of content', () => {
    const diff = `diff --git a/types.d.ts b/types.d.ts
--- a/types.d.ts
+++ b/types.d.ts
@@ -1 +1 @@
-type A = number;
+type A = string;`;
    expect(analyzeDiff(diff)[0]?.apiTouch).toBe(true);
  });

  it('does not mis-skip a hunk-body line that starts like a file header (SQL comment)', () => {
    const diff = `diff --git a/q.sql b/q.sql
--- a/q.sql
+++ b/q.sql
@@ -1,2 +1,2 @@
 SELECT 1;
--- old comment
+-- new comment`;
    const [f] = analyzeDiff(diff);
    expect(f).toMatchObject({ additions: 1, deletions: 1 });
  });
});

describe('isNoiseFile', () => {
  it('matches lockfiles, glob suffixes and vendored path segments', () => {
    expect(isNoiseFile('pnpm-lock.yaml')).toBe(true);
    expect(isNoiseFile('sub/dir/x.min.js')).toBe(true);
    expect(isNoiseFile('a/dist/bundle.js')).toBe(true);
    expect(isNoiseFile('node_modules/pkg/index.js')).toBe(true);
  });
  it('leaves real source files alone', () => {
    expect(isNoiseFile('src/foo.ts')).toBe(false);
    expect(isNoiseFile('README.md')).toBe(false);
  });
});
