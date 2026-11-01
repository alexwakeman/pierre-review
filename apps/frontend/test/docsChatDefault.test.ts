// Activity → Docs: the chat column's default (lib/docsChatDefault.ts) — collapsed unless a
// conversation is under 24 hours old; the reader's own click stands, except that a conversation
// newer than a collapse opens it again.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend docsChatDefault
import { describe, expect, it } from 'vitest';
import { DOCS_CHAT_RECENT_MS, docsChatDefault, latestConversation, parseDocsChatChoice } from '../src/lib/docsChatDefault.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const conv = (id: string, agoMs: number) => ({ conversationId: id, updatedAt: new Date(NOW - agoMs).toISOString() });

describe('docsChatDefault', () => {
  it('is collapsed with no conversations, or while the list loads', () => {
    expect(docsChatDefault({ choice: null, conversations: [], now: NOW })).toEqual({ collapsed: true, conversationId: null });
    expect(docsChatDefault({ choice: null, conversations: undefined, now: NOW })).toEqual({ collapsed: true, conversationId: null });
  });

  it('is collapsed when every conversation is older than 24 hours', () => {
    const r = docsChatDefault({ choice: null, conversations: [conv('a', DOCS_CHAT_RECENT_MS + 1), conv('b', 3 * 24 * HOUR)], now: NOW });
    expect(r).toEqual({ collapsed: true, conversationId: null });
  });

  it('opens on the newest conversation when one is under 24 hours old (any list order)', () => {
    const r = docsChatDefault({ choice: null, conversations: [conv('old', 30 * HOUR), conv('newer', 5 * HOUR), conv('newest', HOUR)], now: NOW });
    expect(r).toEqual({ collapsed: false, conversationId: 'newest' });
    expect(docsChatDefault({ choice: null, conversations: [conv('edge', DOCS_CHAT_RECENT_MS)], now: NOW }).collapsed).toBe(false);
  });

  it('keeps the reader opening it, pre-selecting only a recent conversation', () => {
    const open = { collapsed: false, at: NOW - 48 * HOUR };
    expect(docsChatDefault({ choice: open, conversations: [], now: NOW })).toEqual({ collapsed: false, conversationId: null });
    expect(docsChatDefault({ choice: open, conversations: [conv('old', 30 * HOUR)], now: NOW })).toEqual({ collapsed: false, conversationId: null });
    expect(docsChatDefault({ choice: open, conversations: [conv('r', HOUR)], now: NOW })).toEqual({ collapsed: false, conversationId: 'r' });
  });

  it('keeps the reader collapsing it, even with a recent conversation from before the click', () => {
    const shut = { collapsed: true, at: NOW - HOUR };
    expect(docsChatDefault({ choice: shut, conversations: [conv('r', 2 * HOUR)], now: NOW })).toEqual({ collapsed: true, conversationId: 'r' });
  });

  it('opens again on a conversation updated after the collapse', () => {
    const shut = { collapsed: true, at: NOW - 3 * HOUR };
    expect(docsChatDefault({ choice: shut, conversations: [conv('r', HOUR)], now: NOW })).toEqual({ collapsed: false, conversationId: 'r' });
  });
});

describe('latestConversation', () => {
  it('skips an unparseable timestamp', () => {
    expect(latestConversation([{ conversationId: 'x', updatedAt: 'nope' }])).toBeNull();
    expect(latestConversation([{ conversationId: 'x', updatedAt: 'nope' }, conv('y', HOUR)])?.conversation.conversationId).toBe('y');
  });
});

describe('parseDocsChatChoice', () => {
  it('reads only a well-formed choice', () => {
    expect(parseDocsChatChoice({ collapsed: true, at: 5 })).toEqual({ collapsed: true, at: 5 });
    expect(parseDocsChatChoice(true)).toBeNull();
    expect(parseDocsChatChoice(null)).toBeNull();
    expect(parseDocsChatChoice({ collapsed: 'yes', at: 5 })).toBeNull();
    expect(parseDocsChatChoice({ collapsed: false })).toBeNull();
  });
});
