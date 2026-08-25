// The ad-hoc chat's multi-turn CONVERSATION model — the live per-workspace thread in the store,
// the wire mapping that sends it back as `SprintChatBody.history`, the depth-cap predicate, and
// the two labelled suggestion-pill groups.
//
// What is pinned and why:
//
//   • THE WIRE MAPPING IS THE CLIENT'S HALF OF THE PROTOCOL CAP. `threadToWireHistory` sends the
//     newest ≤ SPRINT_CHAT_MAX_TURNS − 1 pairs (the server re-caps at the same number, its own
//     inlined `CHAT_MAX_PRIOR_TURNS`), oldest→newest, answers only. Sending MORE would not error —
//     the server silently drops the excess and counts it in `trimmedTurns`, so a drifted client
//     cap would whisper "the model couldn't see N turns" on every full-depth ask with no bug
//     visible anywhere else.
//   • A NULL-ANSWER RESPONSE NEVER TRAVELS. The panel never appends one (throttled / credit
//     shapes stay notices), but the mapping is TOTAL anyway — the store is written by more than
//     one path (history seeding), and `{question, answer: ""}` in the prompt would read as the
//     model having answered nothing.
//   • THE STORE SLICE IS PER-WORKSPACE AND IMMUTABLE. Threads key on `ws:<id>`; an append must
//     not mutate the prior array (zustand subscribers compare references) and must not leak into
//     another workspace's transcript.
//   • THE PILL GROUPS ARE TWO DIFFERENT CLAIMS. Report-delta pills render only when the caller
//     passed some (structurally: only when a report is on screen); the built-ins always render.
//     Every built-in prompt must stay ≤500 chars — the server's MAX_QUESTION truncates SILENTLY,
//     so an overlong pill would ship live and mispowered with no error anywhere.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { SPRINT_CHAT_MAX_TURNS, type SprintChatResponse } from '@pierre-review/shared';
import { useFilters, type SprintChatTurn } from '../src/store/filters.js';
import { threadToWireHistory } from '../src/hooks/useSprintChat.js';
import { QUICK_QUESTIONS, suggestionGroups } from '../src/components/Activity/adHocChatModel.js';

function resp(answer: string | null): SprintChatResponse {
  return { enabled: true, answer, prRefs: [] };
}

function turn(question: string, answer: string | null = `answer to ${question}`): SprintChatTurn {
  return { question, response: resp(answer) };
}

describe('threadToWireHistory', () => {
  it('maps completed turns to {question, answer} strings, oldest→newest', () => {
    const wire = threadToWireHistory([turn('q1', 'a1'), turn('q2', 'a2')]);
    expect(wire).toEqual([
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
    ]);
  });

  it('drops turns whose response carries no answer, without disturbing order', () => {
    const wire = threadToWireHistory([turn('q1', 'a1'), turn('q2', null), turn('q3', 'a3')]);
    expect(wire.map((t) => t.question)).toEqual(['q1', 'q3']);
  });

  it('caps at the NEWEST SPRINT_CHAT_MAX_TURNS − 1 pairs', () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(`q${i + 1}`));
    const wire = threadToWireHistory(turns);
    expect(wire).toHaveLength(SPRINT_CHAT_MAX_TURNS - 1);
    // The newest 9 in original order — q4..q12 for 12 sent.
    expect(wire[0]?.question).toBe('q4');
    expect(wire[wire.length - 1]?.question).toBe('q12');
  });

  it('a full-depth thread sends exactly one less pair than the conversation cap', () => {
    // The relationship the whole protocol hangs on: a thread AT the cap (input locked) still
    // fits its prior pairs under the server's re-cap, so nothing is silently trimmed on depth.
    const full = Array.from({ length: SPRINT_CHAT_MAX_TURNS }, (_, i) => turn(`q${i + 1}`));
    expect(threadToWireHistory(full)).toHaveLength(SPRINT_CHAT_MAX_TURNS - 1);
  });

  it('is total over empty input', () => {
    expect(threadToWireHistory([])).toEqual([]);
  });
});

describe('the conversation depth cap', () => {
  it('locks at SPRINT_CHAT_MAX_TURNS completed pairs and not before', () => {
    // The panel's predicate, verbatim: thread.length >= SPRINT_CHAT_MAX_TURNS ⇒ input locked
    // behind "Start a new conversation".
    const nearCap = Array.from({ length: SPRINT_CHAT_MAX_TURNS - 1 }, (_, i) => turn(`q${i}`));
    const atCap = [...nearCap, turn('last')];
    expect(nearCap.length >= SPRINT_CHAT_MAX_TURNS).toBe(false);
    expect(atCap.length >= SPRINT_CHAT_MAX_TURNS).toBe(true);
  });
});

describe('sprintChatThreads store slice', () => {
  beforeEach(() => {
    useFilters.setState({ sprintChatThreads: {} });
  });

  it('starts empty and keys threads per workspace', () => {
    const { appendSprintChatTurn } = useFilters.getState();
    expect(useFilters.getState().sprintChatThreads).toEqual({});
    appendSprintChatTurn('ws:1', turn('q1'));
    appendSprintChatTurn('ws:1', turn('q2'));
    appendSprintChatTurn('ws:2', turn('other'));
    const threads = useFilters.getState().sprintChatThreads;
    expect(threads['ws:1']?.map((t) => t.question)).toEqual(['q1', 'q2']);
    expect(threads['ws:2']?.map((t) => t.question)).toEqual(['other']);
  });

  it('append never mutates the prior array (subscribers compare references)', () => {
    const { appendSprintChatTurn } = useFilters.getState();
    appendSprintChatTurn('ws:1', turn('q1'));
    const before = useFilters.getState().sprintChatThreads['ws:1'];
    appendSprintChatTurn('ws:1', turn('q2'));
    const after = useFilters.getState().sprintChatThreads['ws:1'];
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after).not.toBe(before);
  });

  it('setSprintChatThread seeds a transcript wholesale and [] clears it', () => {
    const { appendSprintChatTurn, setSprintChatThread } = useFilters.getState();
    appendSprintChatTurn('ws:1', turn('live'));
    // The history pick: a fresh 1-turn transcript REPLACES the live one (every replaced turn is
    // already its own server history row).
    setSprintChatThread('ws:1', [turn('picked')]);
    expect(useFilters.getState().sprintChatThreads['ws:1']?.map((t) => t.question)).toEqual([
      'picked',
    ]);
    // "Start a new conversation": the thread empties; other workspaces are untouched.
    appendSprintChatTurn('ws:2', turn('kept'));
    setSprintChatThread('ws:1', []);
    expect(useFilters.getState().sprintChatThreads['ws:1']).toEqual([]);
    expect(useFilters.getState().sprintChatThreads['ws:2']).toHaveLength(1);
  });
});

describe('suggestionGroups', () => {
  it('renders the built-ins alone when no report pills were passed', () => {
    for (const groups of [suggestionGroups(undefined), suggestionGroups([])]) {
      expect(groups.map((g) => g.key)).toEqual(['builtin']);
      expect(groups[0]?.title).toBe('Quick questions');
      expect(groups[0]?.pills).toEqual(QUICK_QUESTIONS);
    }
  });

  it('leads with the labelled report group when delta pills exist', () => {
    const pill = { label: 'Why did Merged PRs fall −33?', question: 'Why…' };
    const groups = suggestionGroups([pill]);
    expect(groups.map((g) => g.key)).toEqual(['report', 'builtin']);
    expect(groups[0]?.title).toBe('From this report');
    expect(groups[0]?.pills).toEqual([pill]);
  });

  it('every built-in prompt survives the server MAX_QUESTION cap and keys uniquely', () => {
    // MAX_QUESTION (500) truncates SILENTLY server-side — an overlong pill ships mispowered
    // with no error anywhere. Labels are React keys within the group, so they must not collide.
    for (const q of QUICK_QUESTIONS) {
      expect(q.question.length).toBeLessThanOrEqual(500);
      expect(q.label).not.toBe('');
    }
    const labels = QUICK_QUESTIONS.map((q) => q.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
