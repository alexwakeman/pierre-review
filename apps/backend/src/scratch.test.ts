// THE SCRATCH STACK'S GUARDS (scratch.ts, scratch-guard.ts; docs/TESTING.md § Scratch stack):
//   1. a scratch backend refuses the real database, data folder and ports;
//   2. config.ts applies that refusal, and installs the write guard, however the process starts;
//   3. the write guard lets reads through and answers every write with a 403 it never sends;
//   4. the two GitHub write seams that are not a fetch (limnWrite, the git push) refuse too.
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scratchRefusal, type ScratchPaths } from './scratch.js';
import {
  assertScratchWriteAllowed,
  graphqlHasMutation,
  installScratchFetchGuard,
  ScratchWriteBlockedError,
  scratchWriteRefusal,
  uninstallScratchFetchGuard,
} from './scratch-guard.js';

const home = mkdtempSync(join(tmpdir(), 'limn-scratch-home-'));
const scratch = mkdtempSync(join(tmpdir(), 'limn-scratch-'));
const ok: ScratchPaths = {
  home,
  dbPath: join(scratch, 'limn.sqlite'),
  dataDir: scratch,
  cloneDir: join(scratch, 'clones'),
  docsDir: join(scratch, 'docs'),
  port: 4200,
  frontendPort: 5373,
};

describe('scratchRefusal', () => {
  it('accepts a self-contained scratch folder', () => {
    expect(scratchRefusal(ok)).toBeNull();
  });

  it.each([
    ['the real data folder', { dataDir: join(home, '.limn'), cloneDir: join(home, '.limn', 'c'), docsDir: join(home, '.limn', 'd') }],
    ['a folder inside it', { dataDir: join(home, '.limn', 'x'), cloneDir: join(home, '.limn', 'x', 'c'), docsDir: join(home, '.limn', 'x', 'd') }],
    ['the legacy data folder', { dataDir: join(home, '.pierre-review'), cloneDir: join(home, '.pierre-review', 'c'), docsDir: join(home, '.pierre-review', 'd') }],
    ['a database in ~/.limn', { dbPath: join(home, '.limn', 'pierre-review.sqlite') }],
    ['the dev default database of ANY checkout', { dbPath: '/somewhere/pierre-review/apps/backend/data/pierre-review.sqlite' }],
    ['a clone folder outside the scratch folder', { cloneDir: join(home, '.limn', 'clones') }],
    ['a docs folder outside the scratch folder', { docsDir: '/tmp/elsewhere-docs' }],
    ['port 4000', { port: 4000 }],
    ['frontend port 5173', { frontendPort: 5173 }],
  ])('refuses %s', (_label, patch) => {
    expect(scratchRefusal({ ...ok, ...patch })).toEqual(expect.any(String));
  });

  it('follows a symlink: a scratch folder that IS ~/.limn is refused', () => {
    const real = join(home, '.limn');
    mkdirSync(real, { recursive: true });
    const link = join(scratch, 'sneaky');
    symlinkSync(real, link);
    expect(
      scratchRefusal({ ...ok, dataDir: link, dbPath: join(link, 'db.sqlite'), cloneDir: join(link, 'c'), docsDir: join(link, 'd') }),
    ).toMatch(/real Limn/);
  });
});

describe('scratchWriteRefusal', () => {
  const gql = (query: string): string => JSON.stringify({ query, variables: {} });
  it.each([
    ['GET', 'https://api.github.com/repos/o/r/pulls', undefined],
    ['POST', 'https://api.github.com/graphql', gql('query { viewer { login } }')],
    ['POST', 'https://api.github.com/graphql', gql('{ repository(owner:"o", name:"mutation") { id } }')],
    ['POST', 'https://api.anthropic.com/v1/messages', '{}'],
    ['POST', 'http://127.0.0.1:8799/classify', '{}'],
    ['POST', 'https://acme.atlassian.net/rest/api/3/search/jql', '{}'],
    ['POST', 'https://api.linear.app/graphql', gql('query { issues { nodes { id } } }')],
    ['POST', 'https://api.notion.com/v1/databases/abc/query', '{}'],
  ])('lets %s %s through', (method, url, body) => {
    expect(scratchWriteRefusal(url, method, body)).toBeNull();
  });

  it.each([
    ['POST', 'https://api.github.com/repos/o/r/pulls/1/reviews', '{}'],
    ['PUT', 'https://api.github.com/repos/o/r/pulls/1/merge', '{}'],
    ['PATCH', 'https://api.github.com/repos/o/r/issues/comments/1', '{}'],
    ['DELETE', 'https://api.github.com/repos/o/r/git/refs/heads/x', undefined],
    ['POST', 'https://api.github.com/graphql', gql('mutation { resolveReviewThread(input:{threadId:"x"}) { thread { id } } }')],
    ['POST', 'https://api.github.com/graphql', gql('# note\nmutation M { addComment { clientMutationId } }')],
    ['POST', 'https://api.github.com/graphql', null],
    ['POST', 'https://uploads.github.com/x', '{}'],
    ['POST', 'https://hooks.slack.com/services/T/B/X', '{}'],
    ['POST', 'https://acme.atlassian.net/rest/api/3/issue/BMD-1/transitions', '{}'],
    ['PUT', 'https://jira.example.org/rest/api/2/issue/BMD-1', '{}'],
    ['POST', 'https://api.linear.app/graphql', gql('mutation { issueUpdate(id:"x") { success } }')],
    ['PATCH', 'https://api.notion.com/v1/pages/abc', '{}'],
    ['DELETE', 'https://example.com/anything', undefined],
  ])('refuses %s %s', (method, url, body) => {
    expect(scratchWriteRefusal(url, method, body)).toEqual(expect.any(String));
  });

  it('spots a mutation in a raw document, not in a string', () => {
    expect(graphqlHasMutation('mutation { x }')).toBe(true);
    expect(graphqlHasMutation('query { search(query: "mutation") { id } }')).toBe(false);
  });
});

describe('the fetch guard', () => {
  afterEach(() => uninstallScratchFetchGuard());

  it('answers a write with a 403 it never sends, and passes a read to the real fetch', async () => {
    const real = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = real as unknown as typeof fetch;
    try {
      installScratchFetchGuard('read');
      const read = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query { viewer { login } }' }),
      });
      expect(read.status).toBe(200);
      const write = await fetch('https://api.github.com/repos/o/r/pulls/1/reviews', { method: 'POST', body: '{}' });
      expect(write.status).toBe(403);
      expect(write.headers.get('x-limn-scratch-blocked')).toBe('1');
      expect(((await write.json()) as { message: string }).message).toMatch(/--github write/);
      const slack = await fetch(new Request('https://hooks.slack.com/services/x', { method: 'POST', body: '{}' }));
      expect(slack.status).toBe(403);
      expect(real).toHaveBeenCalledTimes(1);
    } finally {
      uninstallScratchFetchGuard();
      globalThis.fetch = original;
    }
  });

  it('installs nothing with --github write', () => {
    const before = globalThis.fetch;
    installScratchFetchGuard('write');
    expect(globalThis.fetch).toBe(before);
    expect(() => assertScratchWriteAllowed('x')).not.toThrow();
  });
});

describe('the non-fetch write seams', () => {
  afterEach(() => uninstallScratchFetchGuard());

  it('limnWrite refuses before it runs the write', async () => {
    const { limnWrite } = await import('./github/write-origin.js');
    installScratchFetchGuard('read');
    const run = vi.fn(async () => 1);
    await expect(limnWrite('reader', 'review', {}, run, () => ({}))).rejects.toBeInstanceOf(ScratchWriteBlockedError);
    expect(run).not.toHaveBeenCalled();
  });

  it('a git push is refused before any process starts', async () => {
    const { pushRef, pushForceWithLease } = await import('./coding/git.js');
    installScratchFetchGuard('off');
    const t = {
      worktree: '/nonexistent',
      owner: 'o',
      name: 'r',
      token: 't',
      committish: 'HEAD',
      remoteBranch: 'feature',
      protect: [],
      origin: 'reader' as const,
      limnCommits: [],
    };
    await expect(pushRef(t)).rejects.toThrow(/scratch Limn/);
    await expect(pushForceWithLease({ ...t, leaseSha: 'abc' })).rejects.toThrow(/scratch Limn/);
  });

  it('the tracker transport (node:https, not fetch) refuses a Jira write without a socket', async () => {
    const { nodeTransport } = await import('./tracker/jira/fetch.js');
    installScratchFetchGuard('read');
    const res = await nodeTransport(
      new URL('https://acme.atlassian.net/rest/api/3/issue/BMD-1/transitions'),
      {},
      { lookup: undefined, timeoutMs: 1000, maxBytes: 1000 },
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(403);
  });
});

// Last: it resets the module registry, which would split the guard's state from the static imports above.
describe('config.ts in scratch mode', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    uninstallScratchFetchGuard();
    vi.resetModules();
  });

  const scratchEnv = (patch: Record<string, string>): void => {
    Object.assign(process.env, {
      LIMN_SCRATCH: '1',
      LIMN_DATA_DIR: scratch,
      DATABASE_URL: join(scratch, 'limn.sqlite'),
      CLONE_DIR: join(scratch, 'clones'),
      LIMN_DOCS_DIR: join(scratch, 'docs'),
      PORT: '4200',
      FRONTEND_PORT: '5373',
      ...patch,
    });
  };

  it('refuses to load on the real dev database', async () => {
    scratchEnv({ DATABASE_URL: '/Users/x/pierre-review/apps/backend/data/pierre-review.sqlite' });
    vi.resetModules();
    await expect(import('./config.js')).rejects.toThrow(/Scratch Limn refused to start/);
  });

  it('refuses port 4000', async () => {
    scratchEnv({ PORT: '4000' });
    vi.resetModules();
    await expect(import('./config.js')).rejects.toThrow(/port 4000/);
  });

  it('loads on a scratch folder and installs the write guard', async () => {
    scratchEnv({ LIMN_SCRATCH_GITHUB: 'read' });
    vi.resetModules();
    const { config } = await import('./config.js');
    expect(config.scratch).toEqual({ github: 'read' });
    const guard = await import('./scratch-guard.js');
    expect(guard.activeScratchMode()).toBe('read');
    expect(() => guard.assertScratchWriteAllowed('x')).toThrow(/scratch Limn/);
    guard.uninstallScratchFetchGuard();
  });

  it('a real (non-scratch) config has no scratch block and no guard', async () => {
    delete process.env.LIMN_SCRATCH;
    vi.resetModules();
    const { config } = await import('./config.js');
    expect(config.scratch).toBeNull();
    const guard = await import('./scratch-guard.js');
    expect(guard.activeScratchMode()).toBeNull();
  });
});
