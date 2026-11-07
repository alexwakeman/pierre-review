// Remote parsing: every URL shape a clone can carry → `owner/name`, a credential never returned.
import { describe, expect, it } from 'vitest';
import { parseGitRemote, pickRemote, remotesFromGitConfig } from './remote.js';

describe('parseGitRemote', () => {
  it.each([
    ['git@github.com:DEFRA/bng-metric-backend.git', 'defra/bng-metric-backend'],
    ['git@github.com:DEFRA/bng-metric-backend', 'defra/bng-metric-backend'],
    ['ssh://git@github.com/DEFRA/bng-library.git', 'defra/bng-library'],
    ['ssh://git@github.com:22/DEFRA/bng-library', 'defra/bng-library'],
    ['https://github.com/DEFRA/bng-metric-docs.git', 'defra/bng-metric-docs'],
    ['https://github.com/DEFRA/bng-metric-docs/', 'defra/bng-metric-docs'],
    ['https://x-access-token:ghp_secret@github.com/acme/api.git', 'acme/api'],
    ['git://github.com/acme/api.git', 'acme/api'],
    ['git@github-work:Acme/Api.git', 'acme/api'],
    ['  https://GitHub.com/Acme/Web  ', 'acme/web'],
  ])('%s → %s', (url, slug) => {
    expect(parseGitRemote(url)?.slug).toBe(slug);
  });

  it('keeps the original case in owner and name, and never returns the credential', () => {
    const r = parseGitRemote('https://x-access-token:ghp_secret@github.com/Acme/Api.git')!;
    expect(r).toEqual({ host: 'github.com', owner: 'Acme', name: 'Api', slug: 'acme/api' });
    expect(JSON.stringify(r)).not.toContain('ghp_secret');
  });

  it.each(['', '/local/path/repo', '../repo', 'C:\\repos\\api', 'file:///tmp/repo.git', 'https://github.com/only-owner', 'https://github.com/a/b/c', 'git@github.com:a/..', 'ftp://github.com/a/b'])(
    'refuses %j',
    (url) => {
      expect(parseGitRemote(url)).toBeNull();
    },
  );
});

describe('remotes from a git config', () => {
  const config = [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "upstream"]',
    '\turl = git@github.com:DEFRA/upstream.git',
    '[remote "origin"]',
    '\turl = "git@github.com:me/fork.git"',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[branch "main"]',
    '\tremote = origin',
    '\turl = not-a-remote',
  ].join('\n');

  it('reads each remote once, quoted or not, and ignores other sections', () => {
    const m = remotesFromGitConfig(config);
    expect([...m.entries()]).toEqual([
      ['upstream', 'git@github.com:DEFRA/upstream.git'],
      ['origin', 'git@github.com:me/fork.git'],
    ]);
  });

  it('matches by origin, else upstream, else the first', () => {
    expect(pickRemote(remotesFromGitConfig(config))).toBe('git@github.com:me/fork.git');
    expect(pickRemote(new Map([['upstream', 'u'], ['other', 'o']]))).toBe('u');
    expect(pickRemote(new Map([['other', 'o']]))).toBe('o');
    expect(pickRemote(new Map())).toBeNull();
  });
});
