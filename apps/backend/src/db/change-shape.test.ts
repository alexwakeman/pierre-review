import { describe, expect, it } from 'vitest';
import { classifyChangeShape } from './change-shape.js';

// The comments-vs-code classifier. Its whole design is an ASYMMETRY — every uncertainty resolves
// to `code`/null, never to `comments` — because a wrong `code` leaves a pull request HIGH and
// read carefully, while a wrong `comments` waves a crypto change through. Most of what follows
// is therefore a test that we DON'T claim something.

/** The real patch from golang/go#80721, "crypto/hpke: document sequence counter size" — the pull
 *  request this whole feature exists for. Flagged HIGH because `crypto/` is a contract surface;
 *  every changed line is a `//` doc comment. */
const GO_DOC_PATCH = `@@ -28,14 +28,16 @@ type context struct {

 // Sender is a sending HPKE context. It is instantiated with a specific KEM
 // encapsulation key (i.e. the public key), and it is stateful, incrementing the
-// nonce counter for each [Sender.Seal] call.
+// nonce counter for each [Sender.Seal] call. The counter is 64 bits, which is
+// enough not to overflow for 500 years at 1ns per operation.
 type Sender struct {
 	*context
 }

 // Recipient is a receiving HPKE context. It is instantiated with a specific KEM
 // decapsulation key (i.e. the secret key), and it is stateful, incrementing the
-// nonce counter for each successful [Recipient.Open] call.
+// nonce counter for each successful [Recipient.Open] call. The counter is 64
+// bits, which is enough not to overflow for 500 years at 1ns per operation.
 type Recipient struct {
 	*context
 }`;

describe('classifyChangeShape — the pull request this exists for', () => {
  it('calls golang/go#80721 comments-only', () => {
    expect(
      classifyChangeShape([{ path: 'src/crypto/hpke/hpke.go', patch: GO_DOC_PATCH }]),
    ).toBe('comments');
  });
});

describe('classifyChangeShape — comments', () => {
  it('recognises a single-line comment change in each comment family', () => {
    const cases: [string, string][] = [
      ['src/a.ts', '@@ -1,2 +1,2 @@\n-// old\n+// new'],
      ['src/a.py', '@@ -1,2 +1,2 @@\n-# old\n+# new'],
      ['q.sql', '@@ -1,2 +1,2 @@\n--- old\n+-- new'],
      ['a.erl', '@@ -1,2 +1,2 @@\n-% old\n+% new'],
      ['a.clj', '@@ -1,2 +1,2 @@\n-; old\n+; new'],
    ];
    for (const [path, patch] of cases) {
      expect({ path, got: classifyChangeShape([{ path, patch }]) }).toEqual({
        path,
        got: 'comments',
      });
    }
  });

  it('recognises a block comment that opens and closes across changed lines', () => {
    const patch = [
      '@@ -1,4 +1,5 @@',
      ' function f() {',
      '-  /* one line */',
      '+  /*',
      '+   * two lines now',
      '+   */',
      '   return 1;',
      ' }',
    ].join('\n');
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('comments');
  });

  it('handles a hunk that BEGINS inside a block comment', () => {
    // The patch never says so — it is inferred from a `*/` arriving before any `/*`. Without that
    // inference the first changed line reads as code and a real doc change is called `code`.
    const patch = [
      '@@ -10,4 +10,4 @@',
      '- * the old description',
      '+ * the new description',
      ' */',
      ' export function f() {}',
    ].join('\n');
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('comments');
  });

  it('counts blank lines as comment-compatible', () => {
    const patch = '@@ -1,3 +1,4 @@\n // a\n+\n+// b\n func()';
    expect(classifyChangeShape([{ path: 'src/a.go', patch }])).toBe('comments');
  });

  it('IGNORES non-code files rather than judging them', () => {
    // A README beside a comment-only Go change must not make the answer `code`.
    expect(
      classifyChangeShape([
        { path: 'README.md', patch: '@@ -1 +1 @@\n-old\n+new' },
        { path: 'src/a.go', patch: '@@ -1,2 +1,2 @@\n-// old\n+// new' },
      ]),
    ).toBe('comments');
  });
});

describe('classifyChangeShape — everything that must NOT be called trivial', () => {
  it('a real code change', () => {
    expect(
      classifyChangeShape([{ path: 'src/a.ts', patch: '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;' }]),
    ).toBe('code');
  });

  it('a comment change ALONGSIDE a code change', () => {
    const patch = '@@ -1,4 +1,4 @@\n-// old\n+// new\n-const a = 1;\n+const a = 2;';
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('code');
  });

  it('a comment change in one file and a code change in another', () => {
    expect(
      classifyChangeShape([
        { path: 'src/a.go', patch: '@@ -1,2 +1,2 @@\n-// old\n+// new' },
        { path: 'src/b.go', patch: '@@ -1,2 +1,2 @@\n-x := 1\n+x := 2' },
      ]),
    ).toBe('code');
  });

  it('code trailing a block comment on the same changed line', () => {
    const patch = '@@ -1,2 +1,2 @@\n-/* note */ const a = 1;\n+/* note */ const a = 2;';
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('code');
  });

  it('a comment marker appearing MID-line, not at the start', () => {
    // `const url = "http://x"` must not read as a `//` comment.
    const patch = '@@ -1,2 +1,2 @@\n-const url = "http://a";\n+const url = "http://b";';
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('code');
  });

  it('an UNKNOWN language, however comment-shaped the lines look', () => {
    // ⚠ We do not claim to read a language we have no marker table for.
    const patch = '@@ -1,2 +1,2 @@\n-// old\n+// new';
    expect(classifyChangeShape([{ path: 'src/a.wat', patch }])).toBe('code');
  });
});

describe('classifyChangeShape — the null cases (we did not look)', () => {
  it('a file with NO patch — GitHub omits it for binaries and oversized diffs', () => {
    expect(classifyChangeShape([{ path: 'src/a.ts', patch: null }])).toBeNull();
    expect(classifyChangeShape([{ path: 'src/a.ts' }])).toBeNull();
    // ⚠ One unreadable file poisons the whole answer: the rest may be comments and that one may
    // not be, and we have no way to tell.
    expect(
      classifyChangeShape([
        { path: 'src/a.ts', patch: '@@ -1,2 +1,2 @@\n-// old\n+// new' },
        { path: 'src/big.ts', patch: null },
      ]),
    ).toBeNull();
  });

  it('a pull request with no code files at all', () => {
    // Nothing for this module to say — `codeFiles === 0` is already handled by the level rules.
    expect(classifyChangeShape([{ path: 'README.md', patch: '@@ -1 +1 @@\n-a\n+b' }])).toBeNull();
    expect(classifyChangeShape([])).toBeNull();
  });

  it('an empty patch string', () => {
    expect(classifyChangeShape([{ path: 'src/a.ts', patch: '' }])).toBeNull();
  });
});

describe('classifyChangeShape — formatting', () => {
  it('recognises a pure re-indent', () => {
    const patch = '@@ -1,3 +1,3 @@\n-  const a=1;\n+    const a = 1;\n   return a;';
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('formatting');
  });

  it('recognises a reorder that changes no content', () => {
    const patch = '@@ -1,4 +1,4 @@\n-const a = 1;\n-const b = 2;\n+const b = 2;\n+const a = 1;';
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('formatting');
  });

  it('does NOT call a real edit formatting just because the lines look similar', () => {
    const patch = '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;';
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('code');
  });

  it('works in a language it has no comment markers for', () => {
    // The whitespace comparison needs no syntax, so an unknown extension can still be formatting
    // even though it can never be `comments`.
    const patch = '@@ -1,2 +1,2 @@\n-a=1\n+a = 1';
    expect(classifyChangeShape([{ path: 'src/a.wat', patch }])).toBe('formatting');
  });

  it('COMMENTS WINS over formatting when both would match', () => {
    // A reflowed comment is both. `comments` is the more informative answer and both cap the
    // level identically, so the order is a display choice, pinned so it cannot drift.
    const patch = '@@ -1,2 +1,2 @@\n-//  a\n+// a';
    expect(classifyChangeShape([{ path: 'src/a.ts', patch }])).toBe('comments');
  });
});
