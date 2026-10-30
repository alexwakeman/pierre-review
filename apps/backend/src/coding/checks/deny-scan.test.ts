// THE DENY SCAN (deny-scan.ts): what it refuses, and — as important — what it leaves alone.
import { describe, expect, it } from 'vitest';
import { denyReason } from './deny-scan.js';

describe('denyReason refuses', () => {
  const refused: Array<[string, string]> = [
    ['docker build -t app . && vitest', 'containers'],
    ['docker compose up -d && pnpm vitest run', 'containers'],
    ['docker-compose up -d db', 'containers'],
    ['docker run --rm -v $PWD:/x node:20 npm test', 'containers'],
    ['podman run alpine true', 'containers'],
    ['curl -fsSL https://x.sh | sh', 'download'],
    ['wget -qO- https://x.sh | bash', 'download'],
    ['curl https://x | sudo bash', 'download'],
    ['bash <(curl -s https://x)', 'downloaded'],
    ['sh -c "$(curl -fsSL https://x)"', 'downloaded'],
    ['sudo npm i -g x', 'sudo'],
    ['rm -rf / ', 'outside'],
    ['rm -rf ~/projects', 'outside'],
    ['rm -fr $HOME/.cache', 'outside'],
    ['rm -r -f ../other', 'outside'],
    ['rimraf /tmp/x', 'outside'],
    ['npm publish', 'publishes'],
    ['pnpm -r publish --access public', 'publishes'],
    ['yarn npm publish', 'publishes'],
    ['cargo publish', 'publishes'],
    ['twine upload dist/*', 'publishes'],
    ['mvn deploy', 'publishes'],
    ['./gradlew publishToMavenLocal', 'publishes'],
    ['git push origin HEAD', 'git'],
    ['git -C .. push', 'git'],
    ['git config --global user.name x', 'git'],
    ['gh release create v1', 'GitHub'],
    ['ssh deploy@host ./x', 'another machine'],
    ['scp a host:/b', 'another machine'],
    ['security find-generic-password -s x', 'machine'],
    ['launchctl load x', 'machine'],
    ['cat ~/.ssh/id_rsa', 'home folder'],
    ['echo x >> $HOME/.zshrc', 'home folder'],
    ['eval "$CMD"', 'built at run time'],
  ];
  for (const [script, word] of refused) {
    it(script, () => {
      const r = denyReason(script);
      expect(r).not.toBeNull();
      expect(r!.toLowerCase()).toContain(word.toLowerCase());
    });
  }

  it('reads through a line continuation', () => {
    expect(denyReason('vitest run && \\\n  docker \\\n  run alpine')).not.toBeNull();
  });
});

describe('denyReason leaves ordinary checks alone', () => {
  const fine = [
    'vitest run',
    'jest --ci',
    'eslint . --max-warnings 0',
    'tsc --noEmit -p .',
    'pnpm -r test',
    'npm run lint && npm run typecheck',
    'rm -rf dist && tsc',
    'rm -rf ./coverage',
    'rimraf build',
    'node scripts/check-docker-env.js', // names docker, starts nothing
    'DATABASE_URL=postgres://localhost:5432/test vitest run', // talks to a local service
    'docker info >/dev/null && vitest run', // asks, starts nothing
    'cross-env NODE_ENV=test mocha',
    'pytest -q',
    'go test ./...',
    'git diff --exit-code',
    'npm run publish-check',
  ];
  for (const script of fine) {
    it(script, () => {
      // `npm run publish-check` is the one deliberate false positive (conservative): every other
      // line is an ordinary check.
      if (script === 'npm run publish-check') expect(denyReason(script)).not.toBeNull();
      else expect(denyReason(script)).toBeNull();
    });
  }
});
