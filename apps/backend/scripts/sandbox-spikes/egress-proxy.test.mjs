// Run: node --test apps/backend/scripts/sandbox-spikes/egress-proxy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, parseRules } from './egress-proxy.mjs';

test('exact host, default ports 80/443 only', () => {
  const r = parseRules('registry.npmjs.org');
  assert.equal(allowed(r, 'registry.npmjs.org', 443), true);
  assert.equal(allowed(r, 'REGISTRY.npmjs.org.', 80), true);
  assert.equal(allowed(r, 'registry.npmjs.org', 22), false);
  assert.equal(allowed(r, 'evil-registry.npmjs.org', 443), false);
});

test('suffix rule matches subdomains, not the apex or a lookalike', () => {
  const r = parseRules('*.githubusercontent.com');
  assert.equal(allowed(r, 'objects.githubusercontent.com', 443), true);
  assert.equal(allowed(r, 'githubusercontent.com', 443), false);
  assert.equal(allowed(r, 'evilgithubusercontent.com', 443), false);
});

test('explicit ports and IP literals', () => {
  const r = parseRules('git.example.com:22,*.x.com:*,10.0.0.5');
  assert.equal(allowed(r, 'git.example.com', 22), true);
  assert.equal(allowed(r, 'git.example.com', 443), false);
  assert.equal(allowed(r, 'a.x.com', 8443), true);
  assert.equal(allowed(r, '10.0.0.5', 443), true);
  assert.equal(allowed(r, '10.0.0.6', 443), false);
  assert.equal(allowed(parseRules('*.0.0.1'), '127.0.0.1', 443), false);
});

test('record mode', () => {
  assert.equal(allowed(parseRules('*'), 'anything.example', 9999), true);
});
