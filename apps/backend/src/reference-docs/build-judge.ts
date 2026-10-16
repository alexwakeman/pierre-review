// THE BUILD AGENT'S TOOL CALLS, JUDGED BY THE SERVER (pure — docs/REFERENCE-DOCS.md § The build).
//
// Two build modes:
//   'sections'  (text, markdown, Word, web pages) the SERVER split the text already; the agent reads
//               each file and records a one-line summary (and, optionally, a better title).
//   'pdf'       the agent read the PDF and WROTE the section files itself; it records each one's
//               title, depth and summary in reading order.
// `record_sections` may be called many times (a long document is recorded slice by slice, so a
// context compaction loses nothing); `finish_document` closes the build. A refusal is answered with
// what to fix; after MAX_FINISH_ATTEMPTS the server accepts what it has rather than fail the build.

export type BuildMode = 'sections' | 'pdf';

export const MAX_FINISH_ATTEMPTS = 3;
export const SUMMARY_MAX = 240;
export const TITLE_MAX = 160;
export const DOC_SUMMARY_MAX = 500;
export const TOPICS_MIN = 1;
export const TOPICS_MAX = 12;
export const TOPIC_MAX = 48;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/;

export interface Recorded {
  title: string | null;
  summary: string;
  depth: number;
}

export interface BuildState {
  mode: BuildMode;
  /** 'sections' mode: the server's files, in order. 'pdf': unused (the agent's files are listed live). */
  expected: string[];
  recorded: Map<string, Recorded>;
  /** Reading order of first recording ('pdf' mode). */
  order: string[];
  finishAttempts: number;
}

export function newBuildState(mode: BuildMode, expected: string[] = []): BuildState {
  return { mode, expected: [...expected], recorded: new Map(), order: [], finishAttempts: 0 };
}

const oneLine = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Files the build has not summarised yet ('sections') / written but not recorded ('pdf'). */
export function outstanding(state: BuildState, writtenFiles: readonly string[]): string[] {
  if (state.mode === 'sections') return state.expected.filter((f) => !state.recorded.get(f)?.summary);
  return writtenFiles.filter((f) => FILE_NAME.test(f) && !state.recorded.has(f)).sort();
}

export function judgeRecord(
  state: BuildState,
  payload: unknown,
  writtenFiles: readonly string[],
): { reply: string; isError: boolean; accepted: number } {
  const list = (payload as { sections?: unknown })?.sections;
  if (!Array.isArray(list) || list.length === 0) {
    return { reply: 'Refused: send at least one section.', isError: true, accepted: 0 };
  }
  const problems: string[] = [];
  let accepted = 0;
  const known = new Set(state.mode === 'sections' ? state.expected : writtenFiles);
  for (const raw of list.slice(0, 200)) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const file = oneLine(e.file).replace(/^sections\//, '');
    if (!FILE_NAME.test(file) || !known.has(file)) {
      problems.push(`${file || '(no file)'}: no such section file`);
      continue;
    }
    const summary = oneLine(e.summary);
    if (summary === '') {
      problems.push(`${file}: the summary is empty`);
      continue;
    }
    const title = oneLine(e.title);
    if (state.mode === 'pdf' && title === '') {
      problems.push(`${file}: give its title`);
      continue;
    }
    const depthRaw = typeof e.depth === 'number' && Number.isInteger(e.depth) ? e.depth : 1;
    const depth = Math.max(1, Math.min(6, depthRaw));
    if (!state.recorded.has(file) && state.mode === 'pdf') state.order.push(file);
    state.recorded.set(file, {
      title: title === '' ? null : clip(title, TITLE_MAX),
      summary: clip(summary, SUMMARY_MAX),
      depth,
    });
    accepted += 1;
  }
  const left = outstanding(state, writtenFiles);
  const tail =
    state.mode === 'sections'
      ? `${left.length} file${left.length === 1 ? '' : 's'} still need a summary.`
      : `${state.recorded.size} section${state.recorded.size === 1 ? '' : 's'} recorded so far.`;
  if (problems.length > 0) {
    return {
      reply: `Recorded ${accepted}. Not recorded: ${problems.slice(0, 12).join('; ')}. Fix these and call record_sections again. ${tail}`,
      isError: accepted === 0,
      accepted,
    };
  }
  return { reply: `Recorded ${accepted}. ${tail}`, isError: false, accepted };
}

export function progressReply(state: BuildState, writtenFiles: readonly string[]): string {
  const left = outstanding(state, writtenFiles);
  if (state.mode === 'sections') {
    return left.length === 0
      ? 'Every file has a summary. Call finish_document.'
      : `Still to summarise (${left.length}): ${left.slice(0, 40).join(', ')}${left.length > 40 ? ', …' : ''}`;
  }
  const lastFile = state.order[state.order.length - 1];
  return [
    `Recorded ${state.recorded.size} section${state.recorded.size === 1 ? '' : 's'}${lastFile ? `; the last was ${lastFile} ("${state.recorded.get(lastFile)?.title ?? ''}")` : ''}.`,
    left.length > 0 ? `Written but not recorded: ${left.slice(0, 40).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface AcceptedFinish {
  title: string | null;
  summary: string;
  topics: string[];
}

export function judgeFinish(
  state: BuildState,
  payload: unknown,
  writtenFiles: readonly string[],
): { accepted: AcceptedFinish } | { reply: string } {
  state.finishAttempts += 1;
  const last = state.finishAttempts >= MAX_FINISH_ATTEMPTS;
  const p = (payload ?? {}) as Record<string, unknown>;
  const summary = oneLine(p.summary);
  const topics = (Array.isArray(p.topics) ? p.topics : [])
    .map((t) => clip(oneLine(t), TOPIC_MAX))
    .filter((t, i, all) => t !== '' && all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    .slice(0, TOPICS_MAX);
  const problems: string[] = [];
  if (summary === '') problems.push('give the document a one or two sentence summary');
  if (topics.length < TOPICS_MIN) problems.push('give at least one topic');
  const left = outstanding(state, writtenFiles);
  if (state.mode === 'pdf' && state.recorded.size === 0) problems.push('no sections are recorded yet — write and record them first');
  if (left.length > 0 && !last) {
    problems.push(
      state.mode === 'sections'
        ? `record summaries first for: ${left.slice(0, 15).join(', ')}${left.length > 15 ? ', …' : ''}`
        : `record these written files first: ${left.slice(0, 15).join(', ')}`,
    );
  }
  // The summary and topics are the INDEX entry: without them there is nothing to write, last try or not.
  const fatal = summary === '' || topics.length < TOPICS_MIN || (state.mode === 'pdf' && state.recorded.size === 0);
  if (problems.length > 0 && (!last || fatal)) {
    return { reply: `Refused: ${problems.join('; ')}. Then call finish_document again.` };
  }
  const title = oneLine(p.title);
  return {
    accepted: {
      title: title === '' ? null : clip(title, TITLE_MAX),
      summary: clip(summary, DOC_SUMMARY_MAX),
      topics,
    },
  };
}
