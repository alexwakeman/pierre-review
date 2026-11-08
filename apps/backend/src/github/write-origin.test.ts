// THE GUARD ON GITHUB WRITES (docs/CLAUDE-REVIEW.md § Limn's actions are bots) — modelled on the
// rate-limit tier guard: a new write that forgets to say whose it is, or a Limn write site that does
// not record, fails the build here.
//
//   1. Every exported function in github/mutations.ts that WRITES takes a required last parameter
//      `origin: WriteOrigin` and runs through `limnWrite` (the ledger). Reads are an explicit
//      allow-list, so a new export must be put on one side.
//   2. The same for the Limn post functions in review/post-review.ts, and the git push in
//      coding/git.ts (`PushTarget.origin` + `recordLimnPush`).
//   3. No Limn-run module passes the literal 'reader' to a write: those writes are Limn's and must
//      record. The few reader buttons outside api/routes are listed with their reason.
//   4. Every body Limn posts carries a Limn marker (`isLimnAuthoredBody`), except the one command a
//      bot must read verbatim ("@dependabot rebase"), which the ledger alone makes Limn's.
//
// Pure source reads + pure builders: no database, no GitHub.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLimnAuthoredBody } from '@pierre-review/shared';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** `export async function NAME(params): … {` → { name, params, body } for every export in a file. */
function exportedFunctions(text: string): { name: string; params: string; body: string }[] {
  const out: { name: string; params: string; body: string }[] = [];
  const re = /export (?:async )?function (\w+)(?:<[^>]*>)?\(/g;
  for (let m = re.exec(text); m != null; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < text.length) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    const params = text.slice(start, i - 1);
    // The body: up to the next top-level `\n}\n`.
    const end = text.indexOf('\n}\n', i);
    out.push({ name: m[1]!, params, body: text.slice(i, end === -1 ? undefined : end) });
  }
  return out;
}

// The READS in github/mutations.ts (and pure helpers). Everything else exported there is a write.
const MUTATIONS_READS = new Set([
  'fetchViewerLatestDecisiveReview',
  'githubErrorMessage',
  'fetchPrFilesWithPatch',
  'fetchHeadShaFor',
  'fetchPrHeadInfo',
  'fetchPrForAutomation',
  'fetchBranchHeadSha',
  'fetchMergeability',
  'fetchPrMergeSnapshot',
  'fetchCommitParents',
  'isCommitContainedInRef',
  'fetchPrHeadCheckRollup',
  'fetchRepoMergeConfig',
  'fetchPrUnifiedDiff',
  'filesToUnifiedDiff',
  'fetchMergeQueueState',
  'isWaitableEnqueueRefusal',
  'isFailingEnqueueRefusal',
]);

describe('every GitHub write says whose it is, and Limn\'s record', () => {
  it('github/mutations.ts: each write takes a required `origin: WriteOrigin` last and runs through limnWrite', () => {
    const fns = exportedFunctions(read('github/mutations.ts'));
    const writes = fns.filter((f) => !MUTATIONS_READS.has(f.name));
    // A sanity floor: the writes this guard was written against.
    expect(writes.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'addReviewThreadReply',
        'setReviewThreadResolved',
        'addIssueComment',
        'dismissPrReview',
        'submitPrReview',
        'postInlineComment',
        'updatePullRequestBody',
        'mergePullRequest',
        'closePullRequest',
        'reopenPullRequest',
        'updatePullRequestBranch',
        'createPullRequest',
        'requestReviewers',
        'rerunWorkflowRun',
        'enqueuePullRequestOnQueue',
        'dequeuePullRequestFromQueue',
        'setReaction',
      ]),
    );
    for (const f of writes) {
      expect(f.params, `${f.name}: last parameter must be \`origin: WriteOrigin\``).toMatch(/origin: WriteOrigin,?\s*$/);
      expect(f.body, `${f.name}: must run through limnWrite`).toMatch(/limnWrite\(\s*origin,/);
    }
    // And a read never takes one (a write hiding on the read list would).
    for (const f of fns.filter((x) => MUTATIONS_READS.has(x.name))) {
      expect(f.body, `${f.name} is listed as a read but writes`).not.toMatch(/ghRest(?:Put|Patch|Post)|_MUTATION\b/);
    }
  });

  it('review/post-review.ts: each Limn post takes the origin and records', () => {
    const fns = exportedFunctions(read('review/post-review.ts'));
    const posts = fns.filter((f) => /ghRestPost\b|ghRestPost</.test(f.body));
    expect(posts.map((f) => f.name).sort()).toEqual(['submitGithubComment', 'submitGithubIssueComment', 'submitGithubReview']);
    for (const f of posts) {
      expect(f.params, f.name).toMatch(/origin: WriteOrigin\s*$/);
      expect(f.body, f.name).toMatch(/limnWrite\(\s*origin,/);
    }
  });

  it('coding/git.ts: every push takes the origin and records Limn\'s commits', () => {
    const text = read('coding/git.ts');
    expect(text).toMatch(/interface PushTarget \{[^}]*origin: WriteOrigin;[^}]*limnCommits: readonly string\[\];/s);
    for (const f of exportedFunctions(text).filter((x) => /\['push'|'push',/.test(x.body))) {
      expect(f.body, f.name).toMatch(/recordLimnPush\(t\.origin, t\.limnCommits\)/);
    }
  });

  it('the team-claim status line records', () => {
    const text = read('review/claude-review/team-claim.ts');
    expect(text).toMatch(/limnWrite\(\s*origin,\s*'status'/);
  });
});

// The write functions a Limn-run module may call, and the reader buttons that live outside
// api/routes (with why they are the reader's).
const WRITE_CALL = /\b(addReviewThreadReply|setReviewThreadResolved|addIssueComment|dismissPrReview|submitPrReview|postInlineComment|updatePullRequestBody|mergePullRequest|closePullRequest|reopenPullRequest|updatePullRequestBranch|createPullRequest|requestReviewers|rerunWorkflowRun|enqueuePullRequestOnQueue|dequeuePullRequestFromQueue|setReaction|submitGithubReview|submitGithubComment|submitGithubIssueComment)\(/g;
const READER_BUTTONS: Record<string, string> = {
  'bot-triage/resolve.ts': 'the reader confirms "resolve these bot threads"',
  'merge/dependency-policy.ts': 'the reader presses "Merge all" (their decision, like the merge button)',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('no GitHub write bypasses the guarded functions', () => {
  it('only the guarded modules call a raw REST write (ghRestPost / Put / Patch / Delete)', () => {
    // A raw REST write anywhere else would reach GitHub without an origin and without the ledger.
    const ALLOWED = new Set(['github/client.ts', 'github/mutations.ts', 'review/post-review.ts', 'review/claude-review/team-claim.ts']);
    const raw = /\bghRest(?:Post|Put|Patch|Delete)(?:For)?\s*[<(]/;
    const offenders = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((rel) => !ALLOWED.has(rel) && raw.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('a Limn write site never passes the reader', () => {
  it("no module outside api/routes passes 'reader' to a write (except the listed reader buttons)", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith('api/routes/') || rel.startsWith('github/') || READER_BUTTONS[rel]) continue;
      const text = readFileSync(file, 'utf8');
      for (let m = WRITE_CALL.exec(text); m != null; m = WRITE_CALL.exec(text)) {
        // The call's argument text, to its closing parenthesis.
        let depth = 1;
        let i = m.index + m[0].length;
        while (depth > 0 && i < text.length) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') depth--;
          i++;
        }
        const args = text.slice(m.index + m[0].length, i - 1);
        if (/'reader'\s*,?\s*$/.test(args)) offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('every body Limn posts carries the marker', () => {
  it('the post builders all mark their bodies', async () => {
    const post = await import('../review/post-review.js');
    const finding = { body: 'This can throw.', editedBody: null, suggestion: null, storyLead: null, severity: 'warning' as const };
    expect(isLimnAuthoredBody(post.findingCommentBody(finding, {}))).toBe(true);
    expect(isLimnAuthoredBody(post.findingCommentBody(finding, { fallbackNote: true }))).toBe(true);
    expect(isLimnAuthoredBody(post.prLevelFindingBody({ ...finding, path: 'a.ts', line: 3 }, {}))).toBe(true);
  });

  it('the summary review carries it (the seam appends it to every review)', () => {
    const seam = read('review/post-seam.ts');
    expect(seam).toMatch(/const finalBody = args\.body \+ `\\n\\n\$\{marker\}`/);
  });

  it('every other module that posts a body names a marker (the rebase command is the one exception)', () => {
    // A Limn-run module that calls a comment/review write must carry a `pierre:claude-review` marker
    // constant or builder in the same file.
    const posting = /\b(addReviewThreadReply|addIssueComment|submitPrReview|postInlineComment|submitGithubReview|submitGithubComment|submitGithubIssueComment)\(/;
    const marker = /pierre:claude-review|MARKER|Marker\(|findingCommentBody|prLevelFindingBody|limnReviewMarker|ciCommentBody|storyGapsBody|stillOpenBody|Body\(/;
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith('api/routes/') || rel.startsWith('github/') || READER_BUTTONS[rel]) continue;
      if (rel === 'review/post-review.ts') continue; // the functions themselves
      const text = readFileSync(file, 'utf8');
      if (posting.test(text) && !marker.test(text)) missing.push(rel);
    }
    expect(missing).toEqual([]);
    // The exception, and the reason it is safe: the ledger records it.
    const deps = read('merge/dependency-automation.ts');
    expect(deps).toMatch(/NO MARKER: the bot reads the command[\s\S]{0,200}addIssueComment\([^)]*depsOrigin\(/);
  });
});
