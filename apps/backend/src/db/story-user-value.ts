// "DOES THIS STORY SAY WHO BENEFITS AND WHY?" — CODE, not a model label (Story health's
// `userValueStated` series; shared `STORY_HEALTH_SERIES`). Pure, deterministic, unit-tested
// (story-user-value.test.ts). The prototype labelled it with the model too and agreed with itself
// no better than this rule does, so it moved to code: the same text always gets the same answer,
// and it costs nothing.
//
// TRUE when the story text (title + description + criteria) holds either
//   1. the user-story template WITH its reason — "As a/an <someone>, I want/need/would like …
//      so that …" (also "In order to …, as a …, I want …", the Gherkin narrative order); or
//   2. a "so that" clause NAMING A BENEFICIARY — "so that support staff can …", "so that we no
//      longer …", "so that customers don't …": a subject that is a person or group, then a verb of
//      ability or outcome. "so that it compiles" names no one, and is false.
// The template WITHOUT a reason ("As an admin I want a button") states who but not why: false.
//
// Jira `{color}` markup and Markdown emphasis are stripped first so "*As a* user" still reads.

const COLOR_RE = /\{color[^}]*\}/g;
const EMPHASIS_RE = /[*_]{1,2}/g;

const TEMPLATE_RE = /\bas an?\s+[^.\n]{1,120}?\bi\s+(?:want|need|would like|wish)\b[\s\S]{0,600}?\bso that\b/i;
const NARRATIVE_RE = /\bin order to\b[\s\S]{1,300}?\bas an?\s+[^.\n]{1,120}?\bi\s+(?:want|need|would like|wish)\b/i;

// The subject of a "so that" clause, then a verb of ability / outcome.
const SO_THAT_RE =
  /\bso that\s+((?:[a-z][\w'’-]*\s+){0,3}?[a-z][\w'’-]*)\s+(?:can|could|will|would|may|might|are able|is able|am able|no longer|don't|do not|doesn't|does not|won't|never|always|get|gets|have|has|know|knows|see|sees|understand|understands|receive|receives|spend|spends|avoid|avoids|stop|stops|need not|needn't)\b/gi;

// Subjects that name no one.
const NOT_A_BENEFICIARY = new Set([
  'it', 'this', 'that', 'there', 'which', 'these', 'those', 'code', 'build', 'builds', 'test', 'tests',
  'function', 'method', 'class', 'service', 'endpoint', 'api', 'query', 'job', 'pipeline', 'ci', 'value',
  'field', 'page', 'button', 'system', 'app', 'application', 'component', 'request', 'response', 'data',
]);

/** Is the reason a story's beneficiary gets stated? See the header for the rule. */
export function userValueStated(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(COLOR_RE, '').replace(EMPHASIS_RE, '').replace(/\s+/g, ' ');
  if (t.trim() === '') return false;
  if (TEMPLATE_RE.test(t) || NARRATIVE_RE.test(t)) return true;
  for (const m of t.matchAll(SO_THAT_RE)) {
    const words = m[1]!.toLowerCase().split(/\s+/);
    const head = words[words.length - 1]!;
    if (!NOT_A_BENEFICIARY.has(head)) return true;
  }
  return false;
}

// "DOES THIS STORY NAME WHO IT IS FOR?" — the persona half alone (Reports → This sprint's
// `no_persona` chip). TRUE on the user-story template with or without a reason ("As an admin, I
// want a button"), the "In order to …, as a …" order, or a "so that" clause naming a beneficiary.
// Not having one is NOT "no value": a team with one persona often never writes it down, which is
// why the chip can be switched off per workspace.
const PERSONA_RE = /\bas an?\s+[^.\n]{1,120}?\b(?:i|we)\s+(?:want|need|would like|wish|should|can|must)\b/i;

/** Does the story name who it is for? See the comment above. */
export function personaStated(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(COLOR_RE, '').replace(EMPHASIS_RE, '').replace(/\s+/g, ' ');
  if (t.trim() === '') return false;
  return PERSONA_RE.test(t) || userValueStated(t);
}
