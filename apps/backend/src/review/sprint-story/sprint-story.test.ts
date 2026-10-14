import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPRINT_STORY_VERSION, type SprintGraphEdge, type SprintGraphNode, type SprintStage } from '@pierre-review/shared';
import {
  isLateInSprint,
  isStoryCurrent,
  sprintStoryInput,
  sprintStoryOf,
  sprintStoryStatusOf,
  sprintTimingOf,
  sprintTimingOfDates,
  storyBackedOff,
  storyChains,
  type SprintStoryAttempt,
} from '../../db/sprint-story.js';
import { resetSprintStoryPasses, runSprintStoryPass } from './manager.js';
import { SPRINT_STORY_SYSTEM, sprintStoryPrompt, sprintStoryRetryNote } from './prompt.js';
import { gateNumbers, validateSprintStory } from './validate.js';

// The sprint STORY (docs/CLAUDE-REVIEW.md § Sprint story): code-built candidates, the number gate, the
// pass's gates. Pure — no DB, no model.

const N = (key: string, stage: SprintStage | null, o: Partial<SprintGraphNode> = {}): SprintGraphNode => ({
  ident: `jira:x#${key}`,
  key,
  title: `Title of ${key}`,
  url: null,
  provider: 'jira',
  ghost: false,
  depth: 0,
  status: null,
  stage,
  issueType: null,
  assignee: { name: 'Someone', avatarUrl: null },
  epic: null,
  brief: { state: 'current', summary: null, criteriaCount: 0, criteriaDerived: false },
  prs: [],
  degree: 0,
  theme: null,
  ...o,
});
const dep = (from: string, to: string, why: string | null = null): SprintGraphEdge =>
  ({ from: `jira:x#${from}`, to: `jira:x#${to}`, kind: 'depends_on', source: 'text', quote: 'q', why }) as SprintGraphEdge;

const nodes: SprintGraphNode[] = [
  N('A-1', 'done', { theme: 'Checkout' }),
  N('A-2', 'in_progress', { theme: 'Checkout' }),
  N('A-3', 'not_started', { theme: 'Checkout', assignee: null }),
  N('A-4', 'not_started', { theme: 'Search', assignee: null }),
  N('A-5', 'in_review', {
    theme: 'Search',
    prs: [{ prId: 1, number: 9, repoFullName: 'o/r', title: 't', state: 'open', draft: false, ciState: 'failure', url: 'u', author: null }],
  }),
  N('A-6', 'done', { theme: 'Search' }),
  N('Z-9', 'in_progress', { ghost: true, depth: 1, theme: null }),
];
const edges = [dep('A-3', 'A-2', 'A-3 needs the new cart API from A-2.'), dep('A-2', 'A-1'), dep('A-4', 'Z-9')];
const input = sprintStoryInput({ sprintName: 'Sprint 42', nodes, edges });

describe('sprintStoryInput', () => {
  it('builds facts, the areas of work, chain / risk candidates, all counts by code', () => {
    expect(input.facts).toContain('Sprint: Sprint 42');
    expect(input.facts).toContain('Tickets in the sprint: 6 (done 2, in review 1, in progress 1, not started 2)');
    expect(input.facts).toContain('Tickets with failing checks on an open pull request: 1');
    // The themes are no longer candidates: they are the AREAS OF WORK the focus sentence is written from.
    expect(input.areas).toContain('- "Checkout": 3 tickets (done 1, in review 0, in progress 1, not started 1)');
    expect(input.areas).toContain('- "Search": 3 tickets');
    expect(input.candidates.every((c) => c.kind === 'chain' || c.kind === 'risk')).toBe(true);
    expect(input.candidates.map((c) => c.id)).toEqual(input.candidates.map((_, i) => `C${i + 1}`));
    const chain = input.candidates.find((c) => c.kind === 'chain')!;
    // Delivery order: what is needed first, first; the brief's why rides the link. ⚠ A-1 is done, so the
    // A-2 → A-1 link is no dependency any more and the chain stops at A-2.
    expect(chain.idents).toEqual(['jira:x#A-2', 'jira:x#A-3']);
    expect(chain.text).toContain('needs A-2: "A-3 needs the new cart API from A-2."');
    // ⚠ The waiting risk counts blockers INSIDE the sprint only (A-4 → Z-9 is the code card's).
    const blocked = input.candidates.find((c) => c.text.startsWith('risk — tickets waiting'))!;
    expect(blocked.text.split('\n')[0]).toBe('risk — tickets waiting on unfinished work inside the sprint');
    expect(blocked.idents).toEqual(['jira:x#A-3']);
    expect(input.candidates.some((c) => c.text.startsWith('risk — failing checks'))).toBe(true);
    expect(input.candidates.some((c) => c.text.includes('Not started: 2 of 6 tickets (33%)'))).toBe(true);
    expect(input.keys).toContain('Z-9');
    expect(input.eligible).toBe(true);
    // No person is named.
    expect(JSON.stringify(input)).not.toContain('Someone');
  });

  it('the hash moves with what is sent and nothing else', () => {
    expect(sprintStoryInput({ sprintName: 'Sprint 42', nodes, edges }).inputHash).toBe(input.inputHash);
    const moved = nodes.map((n) => (n.key === 'A-2' ? { ...n, stage: 'in_review' as const } : n));
    expect(sprintStoryInput({ sprintName: 'Sprint 42', nodes: moved, edges }).inputHash).not.toBe(input.inputHash);
    // A field the input does not carry (degree) does not move it.
    const deg = nodes.map((n) => ({ ...n, degree: 7 }));
    expect(sprintStoryInput({ sprintName: 'Sprint 42', nodes: deg, edges }).inputHash).toBe(input.inputHash);
  });

  it('epics stand in when no theme pass covers the sprint; too few tickets is not eligible', () => {
    const plain = nodes.filter((n) => !n.ghost).map((n) => ({ ...n, theme: null, epic: { key: 'E-1', title: 'Payments' } }));
    const i = sprintStoryInput({ sprintName: null, nodes: plain, edges: [] });
    expect(i.areas.split('\n')[0]).toBe('- "Payments" (an epic): 6 tickets (done 2, in review 1, in progress 1, not started 2)');
    // No theme and no epic: the tickets themselves, and a story is still eligible with no candidate.
    const bare = sprintStoryInput({ sprintName: null, nodes: nodes.filter((n) => !n.ghost).map((n) => ({ ...n, theme: null })), edges: [] });
    expect(bare.areas.split('\n')[0]).toBe("- No themes or epics; the sprint's tickets:");
    expect(bare.eligible).toBe(true);
    expect(sprintStoryInput({ sprintName: null, nodes: plain.slice(0, 3), edges: [] }).eligible).toBe(false);
  });

  it('chains: longest first, cycles survive, finished chains are left out', () => {
    const ns = ['B-1', 'B-2', 'B-3', 'B-4'].map((k) => N(k, 'done'));
    expect(storyChains(ns, [dep('B-1', 'B-2'), dep('B-2', 'B-1')])).toEqual([]);
    // ⚠ A prerequisite that is DONE is no dependency: "B-2 depends on B-1, which is done" is never a chain.
    expect(storyChains([N('B-1', 'done', { ghost: true }), N('B-2', 'in_progress')], [dep('B-2', 'B-1')])).toEqual([]);
    expect(storyChains([N('B-1', 'in_review', { ghost: true }), N('B-2', 'in_progress')], [dep('B-2', 'B-1')])).toEqual([['jira:x#B-2', 'jira:x#B-1']]);
    const open = ns.map((n) => ({ ...n, stage: 'in_progress' as const }));
    const c = storyChains(open, [dep('B-1', 'B-2'), dep('B-2', 'B-3'), dep('B-3', 'B-1'), dep('B-4', 'B-3')]);
    expect(c[0]!.length).toBe(3);
  });
});

const answer = (o: unknown) => JSON.stringify(o);
const ids = input.candidates.map((c) => c.id);
const chainId = input.candidates.find((c) => c.kind === 'chain')!.id;
const waitingId = input.candidates.find((c) => c.text.startsWith('risk — tickets waiting'))!.id;
const unassignedId = ids[ids.length - 1]!;
// A chain, the waiting risk and the last risk — a pick that covers every kind.
const PICK = [chainId, waitingId, unassignedId];
const FOCUS = 'The sprint is focused on checkout and search.';

describe('validateSprintStory', () => {
  const good = {
    headline: 'Sprint 42 is about checkout and search, with 2 of 6 tickets done.',
    focus: 'The sprint is focused on checkout and search, with 3 tickets each.',
    storylines: [
      { id: chainId, title: 'Cart path', sentence: 'A-3 waits on A-2, which has not landed; A-3 has not started.' },
      { id: waitingId, title: 'Waiting work', sentence: '1 ticket waits on A-2, which is in progress.' },
      { id: unassignedId, title: 'Unassigned work', sentence: 'Nobody holds A-3 or A-4.' },
    ],
  };

  it('accepts a good answer; kind and idents come from the candidate', () => {
    const v = validateSprintStory(answer(good), input);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.focus).toBe(good.focus);
    const c = input.candidates.find((x) => x.id === waitingId)!;
    expect(v.storylines[1]!.kind).toBe(c.kind);
    expect(v.storylines[1]!.idents).toEqual(c.idents);
  });

  it('⚠ the FOCUS sentence is required, capped and number-gated (facts + areas of work only)', () => {
    expect(validateSprintStory(answer({ ...good, focus: undefined }), input)).toEqual({ ok: false, reason: 'shape' });
    expect(validateSprintStory(answer({ ...good, focus: '   ' }), input)).toEqual({ ok: false, reason: 'shape' });
    expect(validateSprintStory(answer({ ...good, focus: 'x'.repeat(241) }), input)).toEqual({ ok: false, reason: 'too_long' });
    // 33 lives only in the not-started candidate: not the focus's to use.
    expect(validateSprintStory(answer({ ...good, focus: 'Checkout is 33% started.' }), input)).toEqual({ ok: false, reason: 'number' });
    expect(validateSprintStory(answer({ ...good, focus: 'Checkout and three more areas.' }), input)).toEqual({ ok: false, reason: 'number_word' });
    expect(validateSprintStory(answer({ ...good, focus: 'Mostly A-99.' }), input)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(validateSprintStory(answer({ ...good, focus: 'Checkout (A-2, A-3) and search, 6 tickets.' }), input).ok).toBe(true);
  });

  it('no candidates: a headline + focus with no storylines stands', () => {
    const calm = sprintStoryInput({ sprintName: 'Sprint 42', nodes: nodes.filter((n) => !n.ghost).map((n) => ({ ...n, stage: 'done' as const, prs: [] })), edges: [] });
    expect(calm.candidates).toEqual([]);
    expect(validateSprintStory(answer({ headline: 'Sprint 42 is done.', focus: FOCUS, storylines: [] }), calm)).toMatchObject({ ok: true, storylines: [] });
    expect(sprintStoryPrompt(calm, 'n1')).toContain('CANDIDATES:\n(none)');
  });

  it('the number gate: invented number, foreign numeral, unknown key', () => {
    const withLine = (sentence: string) => ({ ...good, storylines: [{ ...good.storylines[0], sentence }, ...good.storylines.slice(1)] });
    expect(validateSprintStory(answer(withLine('Checkout is 70% done.')), input)).toEqual({ ok: false, reason: 'number' });
    expect(validateSprintStory(answer(withLine('Checkout has ٣ tickets.')), input)).toEqual({ ok: false, reason: 'numeral' });
    expect(validateSprintStory(answer(withLine('Checkout has Ⅻ tickets.')), input)).toEqual({ ok: false, reason: 'numeral' });
    expect(validateSprintStory(answer(withLine('A-77 is late.')), input)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(validateSprintStory(answer({ ...good, headline: 'Sprint 43 is about checkout.' }), input)).toEqual({ ok: false, reason: 'number' });
    // A key's own digits are not a number.
    expect(gateNumbers('A-3 and a-4 wait.', new Set(), new RegExp('(?<![A-Za-z0-9_])(?:A-3|A-4)(?![0-9])', 'gi'))).toBeNull();
  });

  it('⚠ a digit in a TITLE is never an allowed count; quoting the title whole passes', () => {
    const ns = nodes.map((n) => (n.key === 'A-2' ? { ...n, title: 'Handle 500 errors in UTF-8 uploads' } : n));
    const i = sprintStoryInput({ sprintName: 'Sprint 42', nodes: ns, edges });
    const g = {
      ...good,
      storylines: [{ ...good.storylines[0], sentence: '500 tickets are blocked.' }, ...good.storylines.slice(1)],
    };
    expect(validateSprintStory(answer(g), i)).toEqual({ ok: false, reason: 'number' });
    const quoted = { ...good, storylines: [{ ...good.storylines[0], sentence: 'Handle 500 errors in UTF-8 uploads is in progress.' }, ...good.storylines.slice(1)] };
    expect(validateSprintStory(answer(quoted), i).ok).toBe(true);
    // The sprint name may be quoted; another sprint number may not.
    expect(validateSprintStory(answer({ ...good, headline: 'Sprint 42 is about checkout.' }), i).ok).toBe(true);
  });

  it('⚠ a number only in a brief reason (model prose) is never an allowed count', () => {
    const e2 = [dep('A-3', 'A-2', 'A-3 needs the 404 page A-2 adds.'), dep('A-2', 'A-1'), dep('A-4', 'Z-9')];
    const i = sprintStoryInput({ sprintName: 'Sprint 42', nodes, edges: e2 });
    const g = { ...good, storylines: [good.storylines[0], { ...good.storylines[1], sentence: '404 tickets wait on A-2.' }, good.storylines[2]] };
    expect(validateSprintStory(answer(g), i)).toEqual({ ok: false, reason: 'number' });
  });

  it('a storyline may only use its own candidate\'s numbers (and the sprint-wide ones)', () => {
    // 33 lives only in the not-started candidate.
    const s = { ...good, storylines: [{ ...good.storylines[0], sentence: 'A-3 is 33% started.' }, ...good.storylines.slice(1)] };
    expect(validateSprintStory(answer(s), input)).toEqual({ ok: false, reason: 'number' });
  });

  it('shape, ids, counts and caps refuse', () => {
    expect(validateSprintStory('nope', input)).toEqual({ ok: false, reason: 'not_json' });
    const five = ids.slice(0, 5).map((id) => ({ id, title: 'A storyline', sentence: 'Where it stands.' }));
    expect(validateSprintStory(answer({ ...good, storylines: five }), input)).toEqual({ ok: false, reason: 'count' });
    expect(validateSprintStory(answer({ ...good, storylines: [...good.storylines.slice(0, 2), { ...good.storylines[0] }] }), input)).toEqual({ ok: false, reason: 'duplicate' });
    expect(validateSprintStory(answer({ ...good, storylines: [...good.storylines.slice(0, 2), { id: 'C99', title: 'x', sentence: 'y' }] }), input)).toEqual({
      ok: false,
      reason: 'unknown_id',
    });
    // Coverage: a chain and a risk candidate exist, so a risks-only pick (or none at all) is refused.
    expect(validateSprintStory(answer({ ...good, storylines: good.storylines.slice(1) }), input)).toEqual({ ok: false, reason: 'coverage' });
    expect(validateSprintStory(answer({ ...good, storylines: [] }), input)).toEqual({ ok: false, reason: 'coverage' });
    expect(validateSprintStory(answer({ ...good, storylines: good.storylines.slice(0, 1) }), input)).toEqual({ ok: false, reason: 'coverage' });
    expect(validateSprintStory(answer({ ...good, headline: 'x'.repeat(201) }), input)).toEqual({ ok: false, reason: 'too_long' });
    const longTitle = { ...good, storylines: [{ ...good.storylines[0], title: 'one two three four five six seven' }, ...good.storylines.slice(1)] };
    expect(validateSprintStory(answer(longTitle), input)).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('digits only (spelled-out counts refused)', () => {
  const good = {
    headline: 'Sprint 42 is about checkout and search, with 2 of 6 tickets done.',
    focus: 'The sprint is focused on checkout and search, with 3 tickets each.',
    storylines: [
      { id: chainId, title: 'Cart path', sentence: 'A-3 waits on A-2, which has not landed; A-3 has not started.' },
      { id: waitingId, title: 'Waiting work', sentence: '1 ticket waits on A-2, which is in progress.' },
      { id: unassignedId, title: 'Unassigned work', sentence: 'Nobody holds A-3 or A-4.' },
    ],
  };
  const withLine = (sentence: string) => ({ ...good, storylines: [{ ...good.storylines[0], sentence }, ...good.storylines.slice(1)] });

  it('refuses two and above as words, any case, whole words only', () => {
    for (const s of ['Checkout has three tickets.', 'Twelve tickets wait.', 'TWENTY-ONE things.', 'A dozen tickets remain.', 'Hundreds of lines.', 'Seventeen are open.', 'Ninety percent is done.', 'Both two tickets wait.']) {
      expect(validateSprintStory(answer(withLine(s)), input)).toEqual({ ok: false, reason: 'number_word' });
    }
    expect(validateSprintStory(answer({ ...good, headline: 'Checkout and search, with two tickets done.' }), input)).toEqual({ ok: false, reason: 'number_word' });
    expect(validateSprintStory(answer({ ...good, storylines: [{ ...good.storylines[0], title: 'Three blockers' }, ...good.storylines.slice(1)] }), input)).toEqual({
      ok: false,
      reason: 'number_word',
    });
  });

  it('allows "one", "a single" and words that merely contain a number word', () => {
    for (const s of ['One of the tickets has not started.', 'A single ticket is left.', 'It often waits on A-2.', 'The tenth attempt is in review.', 'Someone listens.', 'Twentyfold is not a count word here.']) {
      expect(validateSprintStory(answer(withLine(s)), input).ok).toBe(true);
    }
  });

  it('a title quoted whole may carry a number word', () => {
    const ns = nodes.map((n) => (n.key === 'A-2' ? { ...n, title: 'Two-factor login for admins' } : n));
    const i = sprintStoryInput({ sprintName: 'Sprint 42', nodes: ns, edges });
    expect(validateSprintStory(answer(withLine('Two-factor login for admins is in progress.')), i).ok).toBe(true);
    expect(validateSprintStory(answer(withLine('Two tickets wait.')), i)).toEqual({ ok: false, reason: 'number_word' });
  });

  it('the prompt asks for digits', () => {
    expect(SPRINT_STORY_SYSTEM).toContain('DIGITS');
    expect(SPRINT_STORY_SYSTEM).toContain('the only number word allowed is "one"');
  });
});

describe('late in the sprint (a REAL sprint window only)', () => {
  const DAY = 86_400_000;
  const start = Date.UTC(2026, 9, 1, 9); // a 14-day sprint from 1 Oct 09:00
  const sprintW = { fromMs: start, toMs: start + 14 * DAY, mode: 'sprint' };

  it('sprintTimingOf: whole days from the sprint start; the rolling fallback is not a sprint', () => {
    expect(sprintTimingOf({ ...sprintW, mode: 'rolling_14' }, start + 3 * DAY)).toBeNull();
    expect(sprintTimingOf(null, start)).toBeNull();
    expect(sprintTimingOf(sprintW, start)).toEqual({ day: 1, days: 14, daysLeft: 13 });
    expect(sprintTimingOf(sprintW, start + 9 * DAY + 5 * 3_600_000)).toEqual({ day: 10, days: 14, daysLeft: 4 });
    expect(sprintTimingOf(sprintW, start + 20 * DAY)).toEqual({ day: 14, days: 14, daysLeft: 0 });
    expect(isLateInSprint({ day: 9, days: 14, daysLeft: 5 })).toBe(true); // 36% left
    expect(isLateInSprint({ day: 8, days: 14, daysLeft: 6 })).toBe(false); // 43% left
    expect(isLateInSprint(null)).toBe(false);
  });

  it('day facts + the late risk replace the plain not-started risk; no window, no time facts', () => {
    const t = sprintTimingOf(sprintW, start + 9 * DAY)!;
    const late = sprintStoryInput({ sprintName: 'Sprint 42', nodes, edges, timing: t });
    expect(late.facts).toContain('Sprint day: 10 of 14; days left after today: 4');
    const risk = late.candidates.find((c) => c.text.startsWith('risk — work not started late in the sprint'))!;
    expect(risk.idents).toEqual(['jira:x#A-3', 'jira:x#A-4']);
    expect(risk.text).toContain('Not started: 2 of 6 tickets, on day 10 of 14 with 4 days left after today');
    expect(late.candidates.some((c) => c.text.startsWith('risk — work not started\n'))).toBe(false);
    // Early in the sprint: day facts, the plain risk, no late one.
    const early = sprintStoryInput({ sprintName: 'Sprint 42', nodes, edges, timing: sprintTimingOf(sprintW, start + DAY) });
    expect(early.facts).toContain('Sprint day: 2 of 14');
    expect(early.candidates.some((c) => c.text.includes('late in the sprint'))).toBe(false);
    expect(early.candidates.some((c) => c.text.startsWith('risk — work not started\n'))).toBe(true);
    // No sprint window: exactly today's input.
    expect(input.facts).not.toContain('Sprint day');
    expect(input.candidates.some((c) => c.text.includes('late in the sprint'))).toBe(false);
    // One ticket not started is never the late risk.
    const one = nodes.map((n) => (n.key === 'A-4' ? { ...n, stage: 'in_progress' as const } : n));
    expect(sprintStoryInput({ sprintName: 'Sprint 42', nodes: one, edges, timing: t }).candidates.some((c) => c.text.includes('late in the sprint'))).toBe(false);
  });

  it('the headline may use the day facts in digits', () => {
    const late = sprintStoryInput({ sprintName: 'Sprint 42', nodes, edges, timing: sprintTimingOf(sprintW, start + 9 * DAY) });
    const lateId = late.candidates.find((c) => c.text.includes('late in the sprint'))!.id;
    const v = validateSprintStory(
      answer({
        headline: 'Day 10 of 14: checkout and search, with 4 days left.',
        focus: 'Checkout and search, 3 tickets each, with 4 days left.',
        storylines: [
          { id: chainId, title: 'Cart path', sentence: 'A-3 waits on A-2.' },
          { id: lateId, title: 'Not started yet', sentence: '2 tickets have not started with 4 days left.' },
        ],
      }),
      late,
    );
    expect(v.ok).toBe(true);
    // Without the window those numbers are not the code's.
    expect(validateSprintStory(answer({ headline: 'Day 10 of 14: checkout and search.', focus: FOCUS, storylines: [] }), input)).toEqual({ ok: false, reason: 'number' });
  });

  it('⚠ the hash moves once a DAY, never within one', () => {
    const at = (ms: number) => sprintStoryInput({ sprintName: 'Sprint 42', nodes, edges, timing: sprintTimingOf(sprintW, ms) }).inputHash;
    expect(at(start + 9 * DAY + 60_000)).toBe(at(start + 9 * DAY + 23 * 3_600_000));
    expect(at(start + 10 * DAY)).not.toBe(at(start + 9 * DAY));
  });
});

describe('store fold', () => {
  it('current only on hash + version; malformed storylines drop', () => {
    expect(isStoryCurrent({ inputHash: 'h', storyVersion: SPRINT_STORY_VERSION }, 'h')).toBe(true);
    expect(isStoryCurrent({ inputHash: 'h', storyVersion: SPRINT_STORY_VERSION - 1 }, 'h')).toBe(false);
    expect(isStoryCurrent(null, 'h')).toBe(false);
    const s = sprintStoryOf({
      storyJson: { headline: 'H', storylines: [{ kind: 'risk', title: 'T', sentence: 'S', idents: ['a', 3] }, { kind: 'bogus' }] },
      createdAt: new Date(0),
    });
    expect(s).toEqual({ headline: 'H', focus: null, storylines: [{ kind: 'risk', title: 'T', sentence: 'S', idents: ['a'] }], createdAt: '1970-01-01T00:00:00.000Z' });
    expect(sprintStoryOf({ storyJson: { headline: 'H', focus: 'F.', storylines: [] }, createdAt: new Date(0) })).toMatchObject({ headline: 'H', focus: 'F.', storylines: [] });
    expect(sprintStoryOf({ storyJson: { headline: '', storylines: [] }, createdAt: new Date(0) })).toBeNull();
  });

  it('⚠ an OLD story (v3): its theme storylines are dropped and it has no focus until rewritten', () => {
    const old = sprintStoryOf({
      storyJson: {
        headline: 'H',
        storylines: [
          { kind: 'theme', title: 'Checkout', sentence: 'Under way.', idents: ['a'] },
          { kind: 'chain', title: 'Path', sentence: 'Waits.', idents: ['b'] },
        ],
      },
      createdAt: new Date(0),
    });
    expect(old).toEqual({ headline: 'H', focus: null, storylines: [{ kind: 'chain', title: 'Path', sentence: 'Waits.', idents: ['b'] }], createdAt: '1970-01-01T00:00:00.000Z' });
    expect(sprintStoryOf({ storyJson: { headline: 'H', storylines: [{ kind: 'theme', title: 'T', sentence: 'S', idents: [] }] }, createdAt: new Date(0) })?.storylines).toEqual([]);
  });
});

describe('runSprintStoryPass', () => {
  const ctx = (auth = 'ok') => ({
    log: { warn: () => {}, info: () => {}, error: () => {} },
    llm: { detectAuth: () => ({ status: auth }) },
    recordAiUsage: vi.fn(async () => {}),
  });
  const good = answer({
    headline: 'Checkout and search.',
    focus: FOCUS,
    storylines: PICK.map((id) => ({ id, title: 'A storyline', sentence: 'Where it stands.' })),
  });
  beforeEach(() => resetSprintStoryPasses());

  it('one retry, cost recorded, stored with code idents; the prompt fences the facts', async () => {
    const c = ctx();
    const answers = ['garbage', good];
    const complete = vi.fn(async (_req: { prompt: string }) => ({ text: answers.shift()!, usage: { inputTokens: 4000, outputTokens: 300 } }));
    const stored: unknown[] = [];
    const res = await runSprintStoryPass(c as never, 1, 5, {
      aiEnabled: true,
      entitled: async () => true, attempt: async () => null, recordAttempt: async () => {},
      complete: complete as never,
      todo: async () => input,
      isCurrent: async () => false,
      store: async (_a, _w, h, v) => void stored.push([h, v.storylines.map((s) => s.idents)]),
    });
    expect(res).toMatchObject({ state: 'done', storylines: 3 });
    expect(complete).toHaveBeenCalledTimes(2);
    expect((c.recordAiUsage.mock.calls as unknown[][])[0]![0]).toMatchObject({ feature: 'sprint_story' });
    expect(stored).toEqual([[input.inputHash, PICK.map((id) => input.candidates.find((x) => x.id === id)!.idents)]]);
    const prompt = complete.mock.calls[0]![0].prompt;
    expect(prompt).toMatch(/---BEGIN SPRINT FACTS \S+---[\s\S]*---END SPRINT FACTS \S+---$/);
  });

  it('nothing changed / not eligible / AI off / no credential → no call', async () => {
    const complete = vi.fn(async () => ({ text: good, usage: { inputTokens: 0, outputTokens: 0 } }));
    const base = { aiEnabled: true, entitled: async () => true, attempt: async () => null, recordAttempt: async () => {}, complete, todo: async () => input, store: async () => {} };
    expect((await runSprintStoryPass(ctx() as never, 1, 5, { ...base, isCurrent: async () => true })).state).toBe('current');
    expect((await runSprintStoryPass(ctx() as never, 1, 5, { ...base, isCurrent: async () => false, todo: async () => ({ ...input, eligible: false }) })).state).toBe('too_few');
    expect((await runSprintStoryPass(ctx() as never, 1, 5, { ...base, todo: async () => null })).state).toBe('no_tracker');
    expect((await runSprintStoryPass(ctx() as never, 1, 5, { ...base, aiEnabled: false })).state).toBe('off');
    expect((await runSprintStoryPass(ctx('missing') as never, 1, 5, base)).state).toBe('no_credential');
    expect(complete).not.toHaveBeenCalled();
  });

  it('a spelled-out count is refused and retried once', async () => {
    const words = answer({ headline: 'Checkout and search, three tickets left.', focus: FOCUS, storylines: PICK.map((id) => ({ id, title: 'A storyline', sentence: 'Where it stands.' })) });
    const answers = [words, good];
    const complete = vi.fn(async () => ({ text: answers.shift()!, usage: { inputTokens: 0, outputTokens: 0 } }));
    const store = vi.fn(async () => {});
    const r = await runSprintStoryPass(ctx() as never, 1, 5, { aiEnabled: true, entitled: async () => true, attempt: async () => null, recordAttempt: async () => {}, complete, todo: async () => input, isCurrent: async () => false, store });
    expect(r.state).toBe('done');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('⚠ the retry is told why the first answer was refused; the attempt is recorded', async () => {
    const words = answer({ headline: 'Checkout and search, three tickets left.', focus: FOCUS, storylines: PICK.map((id) => ({ id, title: 'A storyline', sentence: 'Where it stands.' })) });
    const answers = [words, good];
    const complete = vi.fn(async (_r: { prompt: string }) => ({ text: answers.shift()!, usage: { inputTokens: 0, outputTokens: 0 } }));
    const recorded: unknown[] = [];
    const r = await runSprintStoryPass(ctx() as never, 1, 5, {
      aiEnabled: true,
      entitled: async () => true,
      attempt: async () => null,
      recordAttempt: async (_a, _w, h, e) => void recorded.push([h, e]),
      complete: complete as never,
      todo: async () => input,
      isCurrent: async () => false,
      store: async () => {},
    });
    expect(r.state).toBe('done');
    expect(complete.mock.calls[0]![0].prompt).not.toContain('refused');
    expect(complete.mock.calls[1]![0].prompt.endsWith(sprintStoryRetryNote('number_word'))).toBe(true);
    expect(recorded).toEqual([[input.inputHash, null]]);
  });

  it('⚠ THE BACKOFF: a failed pass records its reason and is not run again for the same input', async () => {
    let stored: SprintStoryAttempt | null = null;
    const complete = vi.fn(async () => ({ text: 'not json', usage: { inputTokens: 10, outputTokens: 10 } }));
    const seams = {
      aiEnabled: true,
      entitled: async () => true,
      attempt: async () => stored,
      recordAttempt: async (_a: number, _w: number, h: string, e: string | null) => {
        stored = { at: new Date(), inputHash: h, error: e };
      },
      complete,
      todo: async () => input,
      isCurrent: async () => false,
      store: async () => {},
    };
    const first = await runSprintStoryPass(ctx() as never, 1, 5, seams);
    expect(first).toMatchObject({ state: 'failed', failure: 'not_json' });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(stored).toMatchObject({ inputHash: input.inputHash, error: 'not_json' });
    // The next read, same input: no call at all.
    expect((await runSprintStoryPass(ctx() as never, 1, 5, seams)).state).toBe('backoff');
    expect(complete).toHaveBeenCalledTimes(2);
    // The input moved: one pass again.
    const moved = { ...input, inputHash: 'another' };
    expect((await runSprintStoryPass(ctx() as never, 1, 5, { ...seams, todo: async () => moved })).state).toBe('failed');
    expect(complete).toHaveBeenCalledTimes(4);
  });

  it('a call that throws is a failed attempt too (error), backed off alike', async () => {
    const recorded: unknown[] = [];
    const r = await runSprintStoryPass(ctx() as never, 1, 5, {
      aiEnabled: true,
      entitled: async () => true,
      attempt: async () => null,
      recordAttempt: async (_a, _w, h, e) => void recorded.push([h, e]),
      complete: async () => {
        throw new Error('network');
      },
      todo: async () => input,
      isCurrent: async () => false,
      store: async () => {},
    });
    expect(r).toMatchObject({ state: 'failed', failure: 'error' });
    expect(recorded).toEqual([[input.inputHash, 'error']]);
  });

  it('two refusals store nothing', async () => {
    const store = vi.fn(async () => {});
    const complete = vi.fn(async () => ({ text: '{"headline":"x","storylines":[]}', usage: { inputTokens: 0, outputTokens: 0 } }));
    const r = await runSprintStoryPass(ctx() as never, 1, 5, { aiEnabled: true, entitled: async () => true, attempt: async () => null, recordAttempt: async () => {}, complete, todo: async () => input, isCurrent: async () => false, store });
    expect(r.state).toBe('failed');
    expect(store).not.toHaveBeenCalled();
    expect(sprintStoryPrompt(input, 'n1')).toContain('[C1] chain');
    expect(sprintStoryPrompt(input, 'n1')).toContain('AREAS OF WORK:\n- "Checkout"');
  });
});

describe('the tracker\'s sprint dates', () => {
  const DAY = 86_400_000;
  it('sprintTimingOfDates: both ends needed; a part day counts as a day', () => {
    const s = new Date('2026-10-14T10:15:00Z');
    const e = new Date('2026-10-27T17:00:00Z');
    expect(sprintTimingOfDates(s, e, s.getTime() + 60_000)).toEqual({ day: 1, days: 14, daysLeft: 13 });
    expect(sprintTimingOfDates(s, e, s.getTime() + 12 * DAY)).toEqual({ day: 13, days: 14, daysLeft: 1 });
    expect(sprintTimingOfDates(null, e, s.getTime())).toBeNull();
    expect(sprintTimingOfDates(s, null, s.getTime())).toBeNull();
    expect(sprintTimingOfDates(e, s, s.getTime())).toBeNull();
  });
});

describe('⚠ the sprint name\'s short forms are quotable (the ws 1 refusal, 2026-10-14)', () => {
  const named = sprintStoryInput({ sprintName: 'Sprint 15 (Oct 14-27)', nodes, edges });
  const story = (headline: string) =>
    answer({ headline, focus: FOCUS, storylines: PICK.map((id) => ({ id, title: 'A storyline', sentence: 'Where it stands.' })) });
  it('"Sprint 15" and "Oct 14-27" pass; a bare invented number still fails', () => {
    expect(named.verbatim).toEqual(expect.arrayContaining(['Sprint 15 (Oct 14-27)', 'Sprint 15', 'Oct 14-27']));
    expect(validateSprintStory(story('Sprint 15 is about checkout and search.'), named).ok).toBe(true);
    expect(validateSprintStory(story('The sprint runs Oct 14-27.'), named).ok).toBe(true);
    expect(validateSprintStory(story('Sprint 15 has 15 tickets.'), named)).toEqual({ ok: false, reason: 'number' });
    // The name's digits never become counts.
    expect(validateSprintStory(story('The sprint has 27 tickets.'), named)).toEqual({ ok: false, reason: 'number' });
  });
});

describe('sprintStoryStatusOf', () => {
  const base = {
    aiEnabled: true,
    canRun: true,
    eligible: true,
    inputHash: 'h',
    row: null as { inputHash: string; storyVersion: number } | null,
    hasStory: false,
    attempt: null as SprintStoryAttempt | null,
    running: false,
    queued: false,
  };
  const at = new Date('2026-10-14T19:00:00Z');
  it('the states, in order', () => {
    expect(sprintStoryStatusOf({ ...base, aiEnabled: false }).state).toBe('none');
    expect(sprintStoryStatusOf({ ...base, eligible: false }).state).toBe('none');
    expect(sprintStoryStatusOf(base)).toEqual({ state: 'waiting', stale: false, lastAttemptAt: null, failure: null });
    expect(sprintStoryStatusOf({ ...base, row: { inputHash: 'h', storyVersion: SPRINT_STORY_VERSION }, hasStory: true, running: true }).state).toBe('current');
    expect(sprintStoryStatusOf({ ...base, running: true, queued: true }).state).toBe('writing');
    expect(sprintStoryStatusOf({ ...base, queued: true }).state).toBe('queued');
    expect(sprintStoryStatusOf({ ...base, canRun: false }).state).toBe('none');
    expect(sprintStoryStatusOf({ ...base, attempt: { at, inputHash: 'h', error: 'number' } })).toEqual({
      state: 'failed',
      stale: false,
      lastAttemptAt: at.toISOString(),
      failure: 'number',
    });
    // A failure for an OLDER input: the next read tries again.
    expect(sprintStoryStatusOf({ ...base, attempt: { at, inputHash: 'old', error: 'number' } }).state).toBe('waiting');
  });
  it('an older story (older input or older version) shows, marked stale', () => {
    expect(sprintStoryStatusOf({ ...base, row: { inputHash: 'old', storyVersion: SPRINT_STORY_VERSION }, hasStory: true })).toMatchObject({ state: 'waiting', stale: true });
    expect(sprintStoryStatusOf({ ...base, row: { inputHash: 'h', storyVersion: SPRINT_STORY_VERSION - 1 }, hasStory: true })).toMatchObject({ stale: true });
    expect(sprintStoryStatusOf({ ...base, row: { inputHash: 'h', storyVersion: SPRINT_STORY_VERSION }, hasStory: true })).toMatchObject({ state: 'current', stale: false });
  });
  it('storyBackedOff: only a FAILURE for the SAME input', () => {
    expect(storyBackedOff({ at, inputHash: 'h', error: 'shape' }, 'h')).toBe(true);
    expect(storyBackedOff({ at, inputHash: 'h', error: null }, 'h')).toBe(false);
    expect(storyBackedOff({ at, inputHash: 'x', error: 'shape' }, 'h')).toBe(false);
    expect(storyBackedOff(null, 'h')).toBe(false);
  });
});
