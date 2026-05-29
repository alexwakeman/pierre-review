import { execFileSync } from 'node:child_process';

// One-shot at startup. Shell out to the gh CLI so we inherit its SSO/keyring
// handling rather than managing a PAT in-app. Fail loud if gh isn't set up.
export function getGithubToken(): string {
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
    }).trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw new Error(
      'gh CLI not authenticated. Run `gh auth login` first, then restart the app.\n' +
        'For org repos behind SSO you may also need:\n' +
        '  gh auth refresh -h github.com -s read:org',
    );
  }
}
