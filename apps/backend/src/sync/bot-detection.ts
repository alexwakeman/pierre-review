// Known bot logins (without the [bot] suffix). Anything weird gets a manual
// override via PATCH /api/users/:id.
const KNOWN_BOTS = new Set([
  'dependabot',
  'renovate',
  'github-actions',
  'codecov',
  'sonarcloud',
  'snyk-bot',
  'mergify',
  'imgbot',
  'allcontributors',
  'pre-commit-ci',
  'sonarqubecloud',
  'coderabbitai',
]);

export function isLikelyBot(login: string): boolean {
  const lower = login.toLowerCase();
  if (lower.endsWith('[bot]')) return true;
  const stripped = lower.replace(/\[bot\]$/, '');
  return KNOWN_BOTS.has(stripped);
}
