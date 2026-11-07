import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageBuildArgs, imageRecipe, pinnedPullRef, readImagePin, recipeHash, sandboxImageDir } from './image.js';

const args = { CLAUDE_CODE_VERSION: '2.1.295', CODEX_VERSION: '0.164.0' };

describe('the image recipe', () => {
  it('changes with the Dockerfile and with either pin', () => {
    const base = recipeHash('FROM x\n', args);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(recipeHash('FROM y\n', args)).not.toBe(base);
    expect(recipeHash('FROM x\n', { ...args, CODEX_VERSION: '0.165.0' })).not.toBe(base);
    expect(recipeHash('FROM x\n', args)).toBe(base);
  });

  it('dev checkout: the shipped Dockerfile, the SDK bundled CLI and the Codex pin', () => {
    const dir = sandboxImageDir();
    expect(dir).not.toBeNull();
    const pins = imageBuildArgs();
    const pkg = JSON.parse(readFileSync(join(dir!, '..', 'package.json'), 'utf8'));
    expect(pins?.CODEX_VERSION).toBe(pkg.limnAiRuntime['@openai/codex']);
    expect(pins?.CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // The Dockerfile's own defaults must name the same pins (a hand build gets what Limn builds).
    const dockerfile = readFileSync(join(dir!, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`ARG CLAUDE_CODE_VERSION=${pins?.CLAUDE_CODE_VERSION}`);
    expect(dockerfile).toContain(`ARG CODEX_VERSION=${pins?.CODEX_VERSION}`);
    expect(dockerfile).toMatch(/limn\.recipe="\$\{LIMN_RECIPE\}"/);
    const r = imageRecipe()!;
    expect(r.localTag).toBe(`limn-sandbox:local-${r.recipe}`);
  });

  it('release: pins come from the manifest; the pin is used only for the same recipe', () => {
    const root = mkdtempSync(join(tmpdir(), 'limn-release-'));
    const digest = `sha256:${'b'.repeat(64)}`;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'limn-review', limnSandboxImage: { repository: 'ghcr.io/o/limn-sandbox', tag: '1.0.12', digest, recipe: 'abcdefabcdefabcd', buildArgs: args } }),
    );
    expect(imageBuildArgs(root, '/nonexistent')).toEqual(args);
    const pin = readImagePin(root)!;
    expect(pin).toEqual({ repository: 'ghcr.io/o/limn-sandbox', tag: '1.0.12', digest, recipe: 'abcdefabcdefabcd' });
    const ctx = join(root, 'ctx');
    mkdirSync(ctx);
    writeFileSync(join(ctx, 'Dockerfile'), 'FROM x\n');
    const r = imageRecipe({ contextDir: ctx, buildArgs: args })!;
    expect(pinnedPullRef(pin, r)).toBeNull();
    expect(pinnedPullRef({ ...pin, recipe: r.recipe }, r)).toBe(`ghcr.io/o/limn-sandbox@${digest}`);
  });

  it('a file the Dockerfile copies is part of the recipe', () => {
    const ctx = mkdtempSync(join(tmpdir(), 'limn-ctx-'));
    writeFileSync(join(ctx, 'Dockerfile'), 'FROM x\nCOPY limn-svc /usr/local/bin/\n');
    const bare = recipeHash('FROM x\nCOPY limn-svc /usr/local/bin/\n', args);
    writeFileSync(join(ctx, 'limn-svc'), 'v1');
    const one = imageRecipe({ contextDir: ctx, buildArgs: args })!.recipe;
    expect(one).not.toBe(bare);
    writeFileSync(join(ctx, 'limn-svc'), 'v2');
    expect(imageRecipe({ contextDir: ctx, buildArgs: args })!.recipe).not.toBe(one);
  });

  it('a malformed pin is no pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'limn-release-'));
    for (const bad of [{ repository: 'X Y', digest: `sha256:${'b'.repeat(64)}`, recipe: 'abcdefabcdefabcd' }, { repository: 'ghcr.io/o/r', digest: 'latest', recipe: 'abcdefabcdefabcd' }]) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ limnSandboxImage: bad }));
      expect(readImagePin(root)).toBeNull();
    }
  });
});
