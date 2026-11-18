// The PR pane's "Someone else" picker — the pure half (lib/reviewerPicker.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/reviewerPicker.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AskablePerson } from '@pierre-review/shared';
import { pickKey, pickRoom, pickerOptions, REVIEW_REQUEST_LIMIT } from '../src/lib/reviewerPicker.js';

const person = (id: number, login: string, isMaintainer = false, displayName: string | null = null): AskablePerson => ({
  id,
  githubLogin: login,
  displayName,
  avatarUrl: null,
  isBot: false,
  isMaintainer,
  mergedInWorkspace: isMaintainer,
});

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe('pickRoom', () => {
  it('is GitHub’s ceiling less who is requested and who is picked, never negative', () => {
    expect(REVIEW_REQUEST_LIMIT).toBe(15);
    expect(pickRoom(0, 0)).toBe(15);
    expect(pickRoom(3, 2)).toBe(10);
    expect(pickRoom(14, 1)).toBe(0);
    expect(pickRoom(20, 0)).toBe(0);
  });
});

describe('pickerOptions', () => {
  const people = [person(1, 'mia', true), person(2, 'alice', false, 'Alice Smith'), person(3, 'alan')];
  it('keeps the server’s order and drops who is already picked', () => {
    expect(pickerOptions(people, new Set(), '').map((p) => p.githubLogin)).toEqual(['mia', 'alice', 'alan']);
    expect(pickerOptions(people, new Set([2]), '').map((p) => p.githubLogin)).toEqual(['mia', 'alan']);
  });
  it('filters by login or name, ignoring a leading @ and case', () => {
    expect(pickerOptions(people, new Set(), '@AL').map((p) => p.githubLogin)).toEqual(['alice', 'alan']);
    expect(pickerOptions(people, new Set(), 'smith').map((p) => p.githubLogin)).toEqual(['alice']);
  });
});

describe('the picker’s rules', () => {
  it('one mutation key per person', () => {
    expect(pickKey('Alice')).toBe('pick:alice');
  });
  it('fetches only when opened, and sends a chip only once', () => {
    const s = src('components/ReviewerPicker.tsx');
    expect(s).toContain('useAskablePeople(pr.id, workspaceId, open)');
    expect(s).toMatch(/const sendable = picked\.filter\(\(p\) => !tried\.has/);
  });
  it('the Overview mounts it on the PR’s own workspace, only where the reader can push', () => {
    const s = src('components/ChecksTab.tsx');
    expect(s).toMatch(/pr\.state === 'open' && pr\.viewerCanPush && workspaceId != null \? \(/);
    expect(s).toContain("repos?.find((r) => r.id === pr.repoId)?.workspaceId ?? null");
    expect(s).toContain('<Row label="Ask">{someoneElse}</Row>');
  });
});
