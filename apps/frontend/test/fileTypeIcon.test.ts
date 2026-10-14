import { describe, expect, it } from 'vitest';
import { fileTypeIcon } from '../src/lib/fileTypeIcon.js';

describe('fileTypeIcon', () => {
  it.each([
    ['src/index.js', 'javascript'],
    ['lib/a.mjs', 'javascript'],
    ['App.jsx', 'react'],
    ['apps/backend/src/db/queries.ts', 'typescript'],
    ['types/env.d.ts', 'typescript'],
    ['src/App.tsx', 'react_ts'],
    ['tsconfig.json', 'json'],
    ['README.md', 'markdown'],
    ['docs/guide.mdx', 'markdown'],
    ['index.html', 'html'],
    ['styles/main.css', 'css'],
    ['styles/main.scss', 'sass'],
    ['tool/run.py', 'python'],
    ['cmd/main.go', 'go'],
    ['src/lib.rs', 'rust'],
    ['Main.java', 'java'],
    ['build.gradle.kts', 'kotlin'],
    ['App.swift', 'swift'],
    ['app/models/user.rb', 'ruby'],
    ['index.php', 'php'],
    ['main.c', 'c'],
    ['main.h', 'h'],
    ['main.cpp', 'cpp'],
    ['main.hpp', 'hpp'],
    ['Program.cs', 'csharp'],
    ['scripts/release.sh', 'console'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['pyproject.toml', 'toml'],
    ['migrations/0001_init.sql', 'database'],
    ['schema.graphql', 'graphql'],
    ['public/logo.svg', 'svg'],
    ['public/hero.PNG', 'image'],
    ['App.vue', 'vue'],
    ['Button.svelte', 'svelte'],
    ['notes.txt', 'document'],
    ['pom.xml', 'xml'],
    ['refs/Habitat Condition.csv', 'table'],
    ['settings.ini', 'settings'],
  ])('%s → %s by extension', (path, id) => {
    expect(fileTypeIcon(path)).toBe(id);
  });

  it('reads the whole file NAME before the extension', () => {
    expect(fileTypeIcon('package.json')).toBe('nodejs');
    expect(fileTypeIcon('apps/frontend/package.json')).toBe('nodejs');
    expect(fileTypeIcon('Dockerfile')).toBe('docker');
    expect(fileTypeIcon('docker/Dockerfile.prod')).toBe('docker');
    expect(fileTypeIcon('api.dockerfile')).toBe('docker');
    expect(fileTypeIcon('docker-compose.override.yml')).toBe('docker');
    expect(fileTypeIcon('compose.yaml')).toBe('docker');
    expect(fileTypeIcon('pnpm-workspace.yaml')).toBe('pnpm');
    expect(fileTypeIcon('.npmrc')).toBe('npm');
    expect(fileTypeIcon('.yarnrc.yml')).toBe('yarn');
    expect(fileTypeIcon('Makefile')).toBe('settings');
    expect(fileTypeIcon('Cargo.toml')).toBe('rust');
    expect(fileTypeIcon('go.mod')).toBe('go');
    expect(fileTypeIcon('Gemfile')).toBe('ruby');
  });

  it('gives every lock file the padlock, whichever package manager wrote it', () => {
    for (const p of [
      'pnpm-lock.yaml',
      'yarn.lock',
      'package-lock.json',
      'Cargo.lock',
      'Gemfile.lock',
      'poetry.lock',
      'composer.lock',
      'go.sum',
      'bun.lockb',
      'deps/some.lock',
    ]) {
      expect(fileTypeIcon(p), p).toBe('lock');
    }
  });

  it('marks dotenv, git and rc files', () => {
    expect(fileTypeIcon('.env')).toBe('tune');
    expect(fileTypeIcon('apps/backend/.env.example')).toBe('tune');
    expect(fileTypeIcon('.gitignore')).toBe('git');
    expect(fileTypeIcon('.gitattributes')).toBe('git');
    expect(fileTypeIcon('.gitmodules')).toBe('git');
    expect(fileTypeIcon('fix.patch')).toBe('git');
    expect(fileTypeIcon('.prettierrc')).toBe('settings');
    expect(fileTypeIcon('.editorconfig')).toBe('settings');
  });

  it('wears the test flask in the file’s own language family', () => {
    expect(fileTypeIcon('src/a.test.ts')).toBe('test-ts');
    expect(fileTypeIcon('src/a.spec.mts')).toBe('test-ts');
    expect(fileTypeIcon('src/a.test.tsx')).toBe('test-jsx');
    expect(fileTypeIcon('src/a.spec.jsx')).toBe('test-jsx');
    expect(fileTypeIcon('src/a.test.js')).toBe('test-js');
    expect(fileTypeIcon('e2e/a.cy.js')).toBe('test-js');
    expect(fileTypeIcon('src/__snapshots__/a.ts.snap')).toBe('test-ts');
    // Only the JS family has a test mark; other languages keep their own.
    expect(fileTypeIcon('tests/test_api.py')).toBe('python');
    expect(fileTypeIcon('pkg/api_test.go')).toBe('go');
  });

  it('is case-insensitive and tolerates Windows separators', () => {
    expect(fileTypeIcon('SRC\\Main.TS')).toBe('typescript');
    expect(fileTypeIcon('README.MD')).toBe('markdown');
    expect(fileTypeIcon('DOCKERFILE')).toBe('docker');
  });

  it('falls back to the generic file for anything unknown', () => {
    expect(fileTypeIcon('LICENSE')).toBe('file');
    expect(fileTypeIcon('data.bin')).toBe('file');
    expect(fileTypeIcon('weird.')).toBe('file');
    expect(fileTypeIcon('')).toBe('file');
    expect(fileTypeIcon('dir/')).toBe('file');
  });
});
