import {
  DESIGN_ACT_TITLE_MAX,
  DESIGN_ARROW_LABEL_MAX,
  DESIGN_ARROW_LABEL_WORDS,
  DESIGN_CAPTION_MAX,
  DESIGN_CAPTION_SENTENCES,
  DESIGN_CELL_FILES_MAX,
  DESIGN_CELL_LABEL_MAX,
  DESIGN_CHANGES,
  DESIGN_ID_MAX,
  DESIGN_LAYERS,
  DESIGN_LAYER_ORDER,
  DESIGN_MAX_ACTS,
  DESIGN_MAX_ARROWS,
  DESIGN_MAX_CELLS,
  DESIGN_MAX_LAYERS,
  DESIGN_PATTERN_MAX,
  DESIGN_TITLE_MAX,
  type DesignAct,
  type DesignArrow,
  type DesignCell,
  type DesignChange,
  type DesignDiagram,
  type DesignLayer,
} from '@pierre-review/shared';

// THE DESIGN VALIDATOR — every answer passes through here TWICE: inside the agent's `submit_design`
// tool (a refusal lists EVERY problem with what to do about it, so the model resubmits smaller in one
// go) and again before the row is stored. PURE, no I/O. Every cap is the ONE spelling in
// packages/shared/src/sequence-diagrams.ts, which the prompt and the renderer read too.
//
// The model read attacker-authored code and PR text, so its answer is untrusted too. The SPA renders
// every string as React text (never HTML), and this is the first line, not the only one:
//
//   REFUSED      a cap broken (acts, layers, cells, arrows, every string length, files per cell);
//                a duplicate or malformed id; a cell naming an act or layer that is not listed, or a
//                layer outside the FIXED vocabulary; two cells in one (act, layer) slot; a listed act
//                or layer with no cell; no cell carrying a pattern; an arrow to a missing cell or to
//                itself; a story `pr` ref the prompt did not give; anything tag-like (`<x`, `</x`,
//                `<!`) or a URL / scheme (`http:`, `javascript:`, `www.`) in any text.
//   CLEANED      control characters stripped and whitespace collapsed in every string; layers put in
//                canonical order; an empty pattern / arrow label becomes null; a PR design's `pr`
//                becomes null.
//   FILTERED     `files` — kept only when the path is one the change touches (story: the member PR
//                the cell's `pr` names, else any member — and a story cell with no `pr` takes the
//                member owning its first kept file, so a click knows which PR to open). Unknown paths
//                are DROPPED, never refused: a wrong path is a missing link, not a wrong design.

/** What the run knows that the answer is checked against. */
export interface DesignContext {
  kind: 'pr' | 'story';
  // In ref order: PR1 first. A PR design has exactly one.
  prs: ReadonlyArray<{ ref: string; changedFiles: readonly string[] }>;
}

export interface AcceptedDesign {
  title: string | null;
  caption: string | null;
  design: DesignDiagram;
}

export type DesignValidation = { ok: true; value: AcceptedDesign } | { ok: false; problems: string[]; message: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const TAG_LIKE = /<\s*[a-z/!?]/i;
const URL_LIKE = /\b(?:https?|ftp|file|javascript|vbscript|data|mailto):|\bwww\.|:\/\//i;
const ID = new RegExp(`^[A-Za-z0-9_-]{1,${DESIGN_ID_MAX}}$`);
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

/** Every listed path of the changed file set that `raw` names (exact, else a unique suffix match). */
function matchPath(raw: string, changed: ReadonlySet<string>): string | null {
  const p = normPath(raw);
  if (p === '') return null;
  if (changed.has(p)) return p;
  // The model sometimes prefixes a checkout or repository directory.
  const hits = [...changed].filter((c) => p.endsWith(`/${c}`));
  return hits.length === 1 ? hits[0]! : null;
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

  const p = isObj(raw) ? raw : {};
  const title = text('title', p.title, DESIGN_TITLE_MAX, false);
  const caption = text('caption', p.caption, DESIGN_CAPTION_MAX, false);
  if (caption !== '') {
    const sentences = caption.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [caption];
    if (sentences.length > DESIGN_CAPTION_SENTENCES) {
      add(`caption has ${sentences.length} sentences; keep at most ${DESIGN_CAPTION_SENTENCES} short ones.`);
    }
  }

  // ---- acts ----
  const rawActs = Array.isArray(p.acts) ? p.acts : [];
  if (rawActs.length === 0) add('acts is empty; give 1 to 4 stages.');
  if (rawActs.length > DESIGN_MAX_ACTS) {
    add(`${rawActs.length} acts; merge stages so there are at most ${DESIGN_MAX_ACTS}.`);
  }
  const acts: DesignAct[] = [];
  const actIds = new Set<string>();
  rawActs.forEach((a, i) => {
    const o = isObj(a) ? a : {};
    const id = plain(o.id);
    if (!ID.test(id)) add(`act ${i + 1} id "${id.slice(0, 30)}" must be 1-${DESIGN_ID_MAX} letters, digits, - or _.`);
    else if (actIds.has(id)) add(`act id "${id}" is used twice; make act ids unique.`);
    actIds.add(id);
    acts.push({ id, title: text(`act "${id}" title`, o.title, DESIGN_ACT_TITLE_MAX, true) });
  });

  // ---- layers ----
  const rawLayers = Array.isArray(p.layers) ? p.layers.map(plain) : [];
  const known = new Set<string>(DESIGN_LAYER_ORDER);
  const vocab = DESIGN_LAYER_ORDER.join(', ');
  const listed = new Set<DesignLayer>();
  for (const l of rawLayers) {
    if (!known.has(l)) add(`unknown layer "${l.slice(0, 30)}"; use only: ${vocab}.`);
    else if (listed.has(l as DesignLayer)) add(`layer "${l}" is listed twice.`);
    else listed.add(l as DesignLayer);
  }
  if (rawLayers.length === 0) add(`layers is empty; list the 1 to ${DESIGN_MAX_LAYERS} layers the cells use.`);
  if (listed.size > DESIGN_MAX_LAYERS) {
    add(`${listed.size} layers; use at most ${DESIGN_MAX_LAYERS} (drop or fold the least important).`);
  }
  const layers = DESIGN_LAYER_ORDER.filter((l) => listed.has(l));

  // ---- cells ----
  const rawCells = Array.isArray(p.cells) ? p.cells : [];
  if (rawCells.length === 0) add('cells is empty; give at least one.');
  if (rawCells.length > DESIGN_MAX_CELLS) {
    add(`${rawCells.length} cells; merge or drop cells so there are at most ${DESIGN_MAX_CELLS} (fewer is better).`);
  }
  const refs = new Map(ctx.prs.map((x) => [x.ref.toUpperCase(), x]));
  const anyChanged = new Set(ctx.prs.flatMap((x) => x.changedFiles.map(normPath)));
  const cells: DesignCell[] = [];
  const cellIds = new Set<string>();
  const slots = new Map<string, string>();
  rawCells.forEach((c, i) => {
    const o = isObj(c) ? c : {};
    const id = plain(o.id);
    if (!ID.test(id)) add(`cell ${i + 1} id "${id.slice(0, 30)}" must be 1-${DESIGN_ID_MAX} letters, digits, - or _.`);
    else if (cellIds.has(id)) add(`cell id "${id}" is used twice; make cell ids unique.`);
    cellIds.add(id);
    const where = `cell "${id}"`;
    const act = plain(o.act);
    if (!actIds.has(act)) add(`${where} names act "${act.slice(0, 30)}", which is not in acts.`);
    const layer = plain(o.layer);
    if (!known.has(layer)) add(`${where} has unknown layer "${layer.slice(0, 30)}"; use only: ${vocab}.`);
    else if (!listed.has(layer as DesignLayer)) add(`${where} uses layer "${layer}"; add it to layers.`);
    const slot = `${act}\u0000${layer}`;
    const other = slots.get(slot);
    if (other != null) {
      add(`cells "${other}" and "${id}" are both in act "${act}", layer "${layer}"; merge them into one cell.`);
    } else slots.set(slot, id);
    const label = text(`${where} label`, o.label, DESIGN_CELL_LABEL_MAX, true);
    const patternRaw = text(`${where} pattern`, o.pattern, DESIGN_PATTERN_MAX, false);
    const changeRaw = plain(o.change).toLowerCase();
    if (!DESIGN_CHANGES.includes(changeRaw as DesignChange)) {
      add(`${where} change "${changeRaw.slice(0, 20)}" must be one of: ${DESIGN_CHANGES.join(', ')}.`);
    }
    // pr refs: a story's must be one the prompt gave; a PR design's is always null.
    let pr: string | null = null;
    const prRaw = plain(o.pr).toUpperCase();
    if (ctx.kind === 'story' && prRaw !== '') {
      if (!refs.has(prRaw)) add(`${where} names pr "${prRaw.slice(0, 20)}"; use one of: ${[...refs.keys()].join(', ')}, or null.`);
      else pr = prRaw;
    }
    const rawFiles = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string') : [];
    if (rawFiles.length > DESIGN_CELL_FILES_MAX) {
      add(`${where} lists ${rawFiles.length} files; keep the ${DESIGN_CELL_FILES_MAX} most important.`);
    }
    // FILTERED to the change. Story + no pr: any member, then the cell takes the owner of its first file.
    const scope = pr != null ? new Set(refs.get(pr)!.changedFiles.map(normPath)) : anyChanged;
    const files: string[] = [];
    for (const f of rawFiles.slice(0, DESIGN_CELL_FILES_MAX)) {
      const m = matchPath(plain(f), scope);
      if (m != null && !files.includes(m)) files.push(m);
    }
    if (ctx.kind === 'story' && pr == null && files.length > 0) {
      const owner = ctx.prs.find((x) => x.changedFiles.some((cf) => normPath(cf) === files[0]));
      if (owner != null) {
        pr = owner.ref.toUpperCase();
        const own = new Set(owner.changedFiles.map(normPath));
        files.splice(0, files.length, ...files.filter((f) => own.has(f)));
      }
    }
    cells.push({
      id,
      act,
      layer: layer as DesignLayer,
      label,
      pattern: patternRaw === '' ? null : patternRaw,
      change: changeRaw as DesignChange,
      pr,
      files,
    });
  });
  for (const a of acts) {
    if (actIds.has(a.id) && !cells.some((c) => c.act === a.id)) add(`act "${a.id}" has no cell; drop it or give it one.`);
  }
  for (const l of layers) {
    if (!cells.some((c) => c.layer === l)) add(`layer "${l}" has no cell; drop it from layers.`);
  }
  if (cells.length > 0 && !cells.some((c) => c.pattern != null)) {
    add('no cell names a pattern; give the pattern (e.g. "Adapter", "Guard clause") on the cells that use one.');
  }

  // ---- arrows ----
  const rawArrows = Array.isArray(p.arrows) ? p.arrows : [];
  if (rawArrows.length > DESIGN_MAX_ARROWS) {
    add(`${rawArrows.length} arrows; keep only the ${DESIGN_MAX_ARROWS} that carry the design.`);
  }
  const arrows: DesignArrow[] = [];
  const pairs = new Set<string>();
  rawArrows.forEach((a, i) => {
    const o = isObj(a) ? a : {};
    const from = plain(o.from);
    const to = plain(o.to);
    const where = `arrow ${i + 1} (${from.slice(0, 24)} → ${to.slice(0, 24)})`;
    if (!cellIds.has(from) || !cellIds.has(to)) add(`${where} must join two existing cell ids.`);
    if (from === to) add(`${where} points at itself; remove it.`);
    if (pairs.has(`${from}\u0000${to}`)) add(`${where} is drawn twice; keep one.`);
    pairs.add(`${from}\u0000${to}`);
    const label = text(`${where} label`, o.label, DESIGN_ARROW_LABEL_MAX, false);
    if (label !== '' && label.split(' ').length > DESIGN_ARROW_LABEL_WORDS) {
      add(`${where} label has more than ${DESIGN_ARROW_LABEL_WORDS} words; shorten it.`);
    }
    arrows.push({ from, to, label: label === '' ? null : label });
  });

  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    const more = problems.length - shown.length;
    return {
      ok: false,
      problems,
      message: `${shown.map((x) => `- ${x}`).join('\n')}${more > 0 ? `\n- and ${more} more problem(s).` : ''}`,
    };
  }
  return {
    ok: true,
    value: {
      title: title === '' ? null : title,
      caption: caption === '' ? null : caption,
      design: { acts, layers, cells, arrows },
    },
  };
}

/** The display label of a layer (prompt + tests). */
export const layerLabel = (l: DesignLayer): string => DESIGN_LAYERS[l];
