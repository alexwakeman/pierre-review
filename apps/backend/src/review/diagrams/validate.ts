import {
  DESIGN_CAPTION_MAX,
  DESIGN_CAPTION_SENTENCES,
  DESIGN_CHANGES,
  DESIGN_TITLE_MAX,
  FLOW_DECLINE_MAX,
  FLOW_FILES_MUST_MAP,
  FLOW_ID_MAX,
  FLOW_LANE_KINDS,
  FLOW_LANES,
  FLOW_MAX_PARTICIPANTS,
  FLOW_MAX_STEPS,
  FLOW_MIN_PARTICIPANTS,
  FLOW_MIN_STEPS,
  FLOW_PARTICIPANT_LABEL_MAX,
  FLOW_SELF_STEP_KINDS,
  FLOW_STEP_FILES_MAX,
  FLOW_STEP_KINDS,
  FLOW_STEP_LABEL_MAX,
  FLOW_STORE_LANES,
  type DesignChange,
  type FlowDiagram,
  type FlowLaneKind,
  type FlowParticipant,
  type FlowStep,
  type FlowStepKind,
} from '@pierre-review/shared';
import { isTestFile } from '../../db/blast-radius.js';
import { isNonCodeFile } from '../../db/code-loc.js';

// THE DATA-FLOW VALIDATOR — every answer passes through here TWICE: inside the agent's `submit_design`
// tool (a refusal lists EVERY problem with what to do about it, so the model resubmits in one go) and
// again before the row is stored. PURE, no I/O. Every cap is the ONE spelling in
// packages/shared/src/sequence-diagrams.ts, which the prompt and the renderer read too.
//
// The model read attacker-authored code and PR text, so its answer is untrusted too. The SPA renders
// every string as React text (never HTML), and this is the first line, not the only one:
//
//   REFUSED      a cap broken (participants, steps, every string length, files per step); a duplicate
//                or malformed id; a participant kind outside FLOW_LANES; a participant no step uses;
//                steps not numbered 1..n in order; a step naming a missing participant; a step to
//                ITSELF that is not a check or a transform; a `write` that does not end where data is
//                kept (FLOW_STORE_LANES); a step after the first that starts where the data has NOT
//                been yet (no earlier step reached its `from`) — THE CHAIN RULE: the flow is one
//                connected sequence, never a list of areas; a changed CODE file (tests aside) on no
//                step, when there are at most FLOW_FILES_MUST_MAP of them (else fewer than that many
//                mapped); a story `pr` ref the prompt did not give; anything tag-like (`<x`, `</x`,
//                `<!`) or a URL / scheme in any text.
//   DECLINED     `noDiagram` set (PR and story designs only — `ctx.decline`): the model says no data
//                moves through the change. Accepted as a refusal with that reason, which must be plain
//                text within FLOW_DECLINE_MAX; the participants and steps must then be empty.
//   CLEANED      control characters stripped and whitespace collapsed in every string; an empty
//                caption / title becomes null; a PR design's `pr` becomes null.
//   FILTERED     `files` — kept only when the path is one the change touches (story: the member PR
//                the step's `pr` names, else any member — and a story step with no `pr` takes the
//                member owning its first kept file). Unknown paths are DROPPED, never refused: a
//                wrong path is a missing link, not a wrong flow. The coverage rule above counts only
//                the KEPT paths.

/** What the run knows that the answer is checked against. */
export interface DesignContext {
  // 'planned' ("Implement story", coding/story-build/plan.ts): a story's flow BEFORE any PR exists —
  // the refs are the plan's REPOSITORY refs (R1…) and `changedFiles` the files its steps name. It is
  // judged exactly like a story design, except that it may not decline.
  kind: 'pr' | 'story' | 'planned';
  // In ref order: PR1 first (a planned design: R1 first). A PR design has exactly one.
  prs: ReadonlyArray<{ ref: string; changedFiles: readonly string[] }>;
}

export interface AcceptedDesign {
  title: string | null;
  caption: string | null;
  // The flow — null exactly when the model declined (`declined` set).
  flow: FlowDiagram | null;
  // The model's reason no diagram is drawn, finishing "No diagram: …". Null on a drawn flow.
  declined: string | null;
}

export type DesignValidation = { ok: true; value: AcceptedDesign } | { ok: false; problems: string[]; message: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const TAG_LIKE = /<\s*[a-z/!?]/i;
const URL_LIKE = /\b(?:https?|ftp|file|javascript|vbscript|data|mailto):|\bwww\.|:\/\//i;
const ID = new RegExp(`^[A-Za-z0-9_-]{1,${FLOW_ID_MAX}}$`);
const MAX_PROBLEMS = 8;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v);

/** Control characters out, whitespace collapsed. Non-strings read as ''. */
export function plain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** The listed path of the changed file set that `raw` names (exact, else a unique suffix match). */
function matchPath(raw: string, changed: ReadonlySet<string>): string | null {
  const p = normPath(raw);
  if (p === '') return null;
  if (changed.has(p)) return p;
  // The model sometimes prefixes a checkout or repository directory.
  const hits = [...changed].filter((c) => p.endsWith(`/${c}`));
  return hits.length === 1 ? hits[0]! : null;
}

/** A changed file the flow should show: code, and not a test (the existing classifiers, unfolded). */
export function flowRelevantFile(path: string): boolean {
  return !isNonCodeFile(path) && !isTestFile(path);
}

/** Validate, clean and filter one design answer. */
export function validateDesign(raw: unknown, ctx: DesignContext): DesignValidation {
  const problems: string[] = [];
  const add = (p: string): void => {
    if (!problems.includes(p)) problems.push(p);
  };
  const text = (where: string, v: unknown, max: number, required: boolean): string => {
    const s = plain(v);
    if (s === '') {
      if (required) add(`${where} is empty; write it.`);
      return s;
    }
    if (s.length > max) add(`${where} is ${s.length} characters; shorten it to at most ${max}.`);
    if (TAG_LIKE.test(s)) add(`${where} contains a tag-like "<…"; use plain words only.`);
    if (URL_LIKE.test(s)) add(`${where} contains a link or URL; use plain words only.`);
    return s;
  };
  const fail = (): DesignValidation => {
    const shown = problems.slice(0, MAX_PROBLEMS);
    const more = problems.length - shown.length;
    return {
      ok: false,
      problems,
      message: `${shown.map((x) => `- ${x}`).join('\n')}${more > 0 ? `\n- and ${more} more problem(s).` : ''}`,
    };
  };

  const p = isObj(raw) ? raw : {};
  const rawParts = Array.isArray(p.participants) ? p.participants : [];
  const rawSteps = Array.isArray(p.steps) ? p.steps : [];

  // ---- a declined answer ----
  const declineRaw = plain(p.noDiagram);
  if (declineRaw !== '') {
    if (ctx.kind === 'planned') {
      add('noDiagram is not allowed here: the person asked for this design; draw it.');
      return fail();
    }
    const reason = text('noDiagram', declineRaw, FLOW_DECLINE_MAX, true).replace(/^no diagram:\s*/i, '');
    if (rawParts.length > 0 || rawSteps.length > 0) {
      add('noDiagram is set but participants or steps are not empty; either draw the flow (noDiagram null) or leave them empty.');
    }
    if (problems.length > 0) return fail();
    return { ok: true, value: { title: null, caption: null, flow: null, declined: reason } };
  }

  const title = text('title', p.title, DESIGN_TITLE_MAX, false);
  const caption = text('caption', p.caption, DESIGN_CAPTION_MAX, false);
  if (caption !== '') {
    const sentences = caption.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [caption];
    if (sentences.length > DESIGN_CAPTION_SENTENCES) {
      add(`caption has ${sentences.length} sentences; keep at most ${DESIGN_CAPTION_SENTENCES} short ones.`);
    }
  }

  const refs = new Map(ctx.prs.map((x) => [x.ref.toUpperCase(), x]));
  const refList = [...refs.keys()].join(', ');
  const story = ctx.kind !== 'pr';
  /** A story / planned ref the prompt gave, or null (a PR design's is always null). */
  const refOf = (where: string, v: unknown): string | null => {
    const r = plain(v).toUpperCase();
    if (!story || r === '') return null;
    if (!refs.has(r)) {
      add(`${where} names pr "${r.slice(0, 20)}"; use one of: ${refList}, or null.`);
      return null;
    }
    return r;
  };

  // ---- participants ----
  if (rawParts.length < FLOW_MIN_PARTICIPANTS) {
    add(
      `${rawParts.length} participant(s); a flow needs at least ${FLOW_MIN_PARTICIPANTS} (where the data comes from and where it goes). If no data moves through this change, set noDiagram instead.`,
    );
  }
  if (rawParts.length > FLOW_MAX_PARTICIPANTS) {
    add(`${rawParts.length} participants; merge the minor ones so there are at most ${FLOW_MAX_PARTICIPANTS}.`);
  }
  const kinds = new Set<string>(FLOW_LANE_KINDS);
  const participants: FlowParticipant[] = [];
  const partIds = new Map<string, FlowParticipant>();
  rawParts.forEach((x, i) => {
    const o = isObj(x) ? x : {};
    const id = plain(o.id);
    if (!ID.test(id)) add(`participant ${i + 1} id "${id.slice(0, 30)}" must be 1-${FLOW_ID_MAX} letters, digits, - or _.`);
    else if (partIds.has(id)) add(`participant id "${id}" is used twice; make participant ids unique.`);
    const where = `participant "${id}"`;
    const kind = plain(o.kind).toLowerCase();
    if (!kinds.has(kind)) add(`${where} kind "${kind.slice(0, 20)}" must be one of: ${FLOW_LANE_KINDS.join(', ')}.`);
    const change = plain(o.change).toLowerCase();
    if (!DESIGN_CHANGES.includes(change as DesignChange)) {
      add(`${where} change "${change.slice(0, 20)}" must be one of: ${DESIGN_CHANGES.join(', ')}.`);
    }
    const part: FlowParticipant = {
      id,
      kind: kind as FlowLaneKind,
      label: text(`${where} label`, o.label, FLOW_PARTICIPANT_LABEL_MAX, true),
      change: change as DesignChange,
      pr: refOf(where, o.pr),
    };
    participants.push(part);
    if (!partIds.has(id)) partIds.set(id, part);
  });

  // ---- steps ----
  if (rawSteps.length < FLOW_MIN_STEPS) {
    add(`${rawSteps.length} step(s); a flow needs at least ${FLOW_MIN_STEPS}. If no data moves through this change, set noDiagram instead.`);
  }
  if (rawSteps.length > FLOW_MAX_STEPS) {
    add(`${rawSteps.length} steps; merge steps so there are at most ${FLOW_MAX_STEPS} (fewer is better).`);
  }
  const stepKinds = new Set<string>(FLOW_STEP_KINDS);
  const anyChanged = new Set(ctx.prs.flatMap((x) => x.changedFiles.map(normPath)));
  const reached = new Set<string>();
  const used = new Set<string>();
  const steps: FlowStep[] = [];
  rawSteps.forEach((x, i) => {
    const o = isObj(x) ? x : {};
    const expected = i + 1;
    const n = typeof o.n === 'number' ? o.n : Number(plain(o.n));
    if (n !== expected) add(`step ${expected} is numbered "${String(o.n).slice(0, 8)}"; number the steps 1, 2, 3, … in the order they happen.`);
    const where = `step ${expected}`;
    const from = plain(o.from);
    const to = plain(o.to);
    const kind = plain(o.kind).toLowerCase();
    const fromP = partIds.get(from);
    const toP = partIds.get(to);
    if (fromP == null) add(`${where} starts at "${from.slice(0, 24)}", which is not a participant id.`);
    if (toP == null) add(`${where} goes to "${to.slice(0, 24)}", which is not a participant id.`);
    if (!stepKinds.has(kind)) add(`${where} kind "${kind.slice(0, 20)}" must be one of: ${FLOW_STEP_KINDS.join(', ')}.`);
    else {
      if (from === to && !FLOW_SELF_STEP_KINDS.includes(kind as FlowStepKind)) {
        add(`${where} goes from "${from}" to itself as a ${kind}; only a validate or a transform stays on one participant.`);
      }
      if (kind === 'write' && toP != null && !FLOW_STORE_LANES.includes(toP.kind)) {
        add(
          `${where} is a write to "${to}" (${FLOW_LANES[toP.kind] ?? toP.kind}); a write ends where data is kept (${FLOW_STORE_LANES.join(', ')}). Use call, emit or return, or point it at the store.`,
        );
      }
    }
    // THE CHAIN RULE: the data is somewhere already before it moves on.
    if (i > 0 && fromP != null && !reached.has(from)) {
      add(`${where} starts at "${from}", which no earlier step reached; start each step where the data already is, so the steps form one chain.`);
    }
    reached.add(from);
    reached.add(to);
    used.add(from);
    used.add(to);
    const label = text(`${where} label`, o.label, FLOW_STEP_LABEL_MAX, true);
    let pr = refOf(where, o.pr);
    const rawFiles = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string') : [];
    if (rawFiles.length > FLOW_STEP_FILES_MAX) {
      add(`${where} lists ${rawFiles.length} files; keep the ${FLOW_STEP_FILES_MAX} that do this step.`);
    }
    // FILTERED to the change. Story + no pr: any member, then the step takes the owner of its first file.
    const scope = pr != null ? new Set(refs.get(pr)!.changedFiles.map(normPath)) : anyChanged;
    const files: string[] = [];
    for (const f of rawFiles.slice(0, FLOW_STEP_FILES_MAX)) {
      const m = matchPath(plain(f), scope);
      if (m != null && !files.includes(m)) files.push(m);
    }
    if (story && pr == null && files.length > 0) {
      const owner = ctx.prs.find((m) => m.changedFiles.some((cf) => normPath(cf) === files[0]));
      if (owner != null) {
        pr = owner.ref.toUpperCase();
        const own = new Set(owner.changedFiles.map(normPath));
        files.splice(0, files.length, ...files.filter((f) => own.has(f)));
      }
    }
    steps.push({ n: expected, from, to, kind: kind as FlowStepKind, label, pr, files });
  });
  for (const part of participants) {
    if (partIds.get(part.id) === part && !used.has(part.id)) {
      add(`participant "${part.id}" is in no step; drop it or show the step that reaches it.`);
    }
  }

  // ---- every changed code file on a step (tests aside) ----
  const relevant = [...new Set([...anyChanged].filter(flowRelevantFile))];
  const mapped = new Set(steps.flatMap((s) => s.files));
  const missing = relevant.filter((f) => !mapped.has(f));
  const need = Math.min(relevant.length, FLOW_FILES_MUST_MAP);
  if (relevant.length - missing.length < need) {
    const list = missing.slice(0, 5).join(', ');
    add(
      relevant.length <= FLOW_FILES_MUST_MAP
        ? `these changed files are on no step: ${list}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}; put each in the files of the step its code performs.`
        : `only ${relevant.length - missing.length} changed files are on a step; put at least ${need} in the files of the steps their code performs (not yet placed: ${list}).`,
    );
  }

  if (problems.length > 0) return fail();
  return {
    ok: true,
    value: {
      title: title === '' ? null : title,
      caption: caption === '' ? null : caption,
      flow: { participants, steps },
      declined: null,
    },
  };
}

/** An accepted design back in the tool's shape (the manager validates it once more before storing). */
export function acceptedAsPayload(a: AcceptedDesign): Record<string, unknown> {
  if (a.flow == null) return { title: null, caption: null, participants: [], steps: [], noDiagram: a.declined };
  return { title: a.title, caption: a.caption, participants: a.flow.participants, steps: a.flow.steps, noDiagram: null };
}
