// TRACKER TEXT, TIDIED FOR DISPLAY (Reports → This sprint; `<Markdown ticketLinks>`).
//
// Jira's editor lets a list be indented under an EMPTY bullet, which the server's ADF conversion
// printed as "- - a" with the rest of the inner list indented under it — rendered as a bullet holding
// a bullet ("• • a"). The converter no longer writes it (tracker/jira/text.ts), but text stored before
// that keeps it until the next read. `flattenEmptyListItems` prints the inner list in the empty item's
// place: "- - a" → "- a", and the inner list's following lines move out by the outer marker's width.
// Only the MARKERS change — the words are untouched, so highlights and quotes still find their text.

const EMPTY_ITEM_RE = /^(\s*)([-*+]) +([-*+] .*)$/;
// "- - -" / "* * *" is a horizontal rule, not a list.
const THEMATIC_BREAK_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function flattenEmptyListItems(md: string): string {
  let cur = md;
  // A doubled-up item ("- - - a") folds one level per pass.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = flattenOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function flattenOnce(md: string): string {
  if (!/[-*+] +[-*+] /.test(md)) return md;
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i]!;
    const m = THEMATIC_BREAK_RE.test(line) ? null : EMPTY_ITEM_RE.exec(line);
    if (m == null) {
      out.push(line);
      continue;
    }
    const indent = m[1]!;
    const width = line.length - indent.length - m[3]!.length; // the outer marker + its spaces
    line = `${indent}${m[3]!}`;
    out.push(line);
    // The inner list's further lines sat under the empty item: move them out by its marker's width.
    const under = indent + ' '.repeat(width);
    while (i + 1 < lines.length && lines[i + 1]!.startsWith(under) && lines[i + 1]!.trim() !== '') {
      i += 1;
      out.push(indent + lines[i]!.slice(under.length));
    }
  }
  return out.join('\n');
}
