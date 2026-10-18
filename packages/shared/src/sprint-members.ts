import type { SprintGraphNode } from './sprint-graph.js';

// THIS SPRINT'S PEOPLE — ONE entry per person, across the tracker and GitHub. The ONE mapping from a
// tracker assignee to GitHub logins: the SPA's People lanes (lib/laneBoard.ts `peopleBoard`)
// and the server's `SprintGraphResponse.people` (db/sprint-paths.ts `sprintPeopleOf`)
// both fold through it, so they can never disagree about who a person is.
//
// A ticket names its assignee as the TRACKER spells them ("Johny Farrar", "johny.farrar"); a PR names
// its author by GitHub login and profile name ("jbfarrar" / "Johny Farrar"). A People lane lists a
// person ONCE and matches both their tickets and their PRs. The join is EXACT after setting aside case,
// accents, spacing and the punctuation people use between name parts (`personNameKey`): an assignee
// joins a GitHub author whose profile name or login reads the same, or whose login is the name run
// together ("Sinan Goktas" ↔ `sinangoktas`). Nothing is guessed: a login that would join two different
// assignees joins neither and is listed on its own.

/** A person's name with case, accents, spacing and `. _ -` between parts set aside. */
export function personNameKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[._\-\s]+/g, ' ')
    .trim();
}

const compactKey = (k: string): string => k.replace(/ /g, '');

export interface SprintMember {
  /** The select's value: `p:<name key>` for a tracker person, `gh:<login>` for a GitHub-only one. */
  id: string;
  label: string;
  /** The assignee names (as the wire spells them) that are this person. */
  names: string[];
  /** The GitHub logins that are this person. */
  logins: string[];
}

/** One member per person over the SPRINT tickets' assignees and their PRs' authors, by label. Pure. */
export function sprintMembers(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ghost' | 'assignee' | 'prs'>>,
): SprintMember[] {
  const people = new Map<string, string[]>();
  const authors = new Map<string, string | null>();
  for (const n of nodes) {
    if (n.ghost) continue;
    if (n.assignee != null && n.assignee.name.trim() !== '') {
      const k = personNameKey(n.assignee.name);
      const l = people.get(k);
      if (l == null) people.set(k, [n.assignee.name]);
      else if (!l.includes(n.assignee.name)) l.push(n.assignee.name);
    }
    for (const p of n.prs) {
      if (p.author == null || p.author.isBot === true) continue;
      if (!authors.has(p.author.login) || authors.get(p.author.login) == null) authors.set(p.author.login, p.author.name);
    }
  }
  const linked = new Map<string, string[]>();
  const alone: string[] = [];
  for (const [login, name] of authors) {
    const lk = personNameKey(login);
    const hits = new Set<string>();
    for (const k of people.keys()) {
      if ((name != null && personNameKey(name) === k) || lk === k || compactKey(lk) === compactKey(k)) hits.add(k);
    }
    if (hits.size === 1) {
      const k = [...hits][0] as string;
      linked.set(k, [...(linked.get(k) ?? []), login]);
    } else alone.push(login);
  }
  // A label reads as a real name where one is on offer: spaced and capitalised beats "johny.farrar".
  const pick = (cands: ReadonlyArray<string | null | undefined>): string | null => {
    const list = cands.filter((c): c is string => c != null && c.trim() !== '');
    return (
      list.find((c) => /\s/.test(c.trim()) && /\p{Lu}/u.test(c)) ?? list.find((c) => /\s/.test(c.trim())) ?? list[0] ?? null
    );
  };
  const out: SprintMember[] = [];
  for (const [k, names] of people) {
    const logins = (linked.get(k) ?? []).sort();
    out.push({ id: `p:${k}`, label: pick([...names, ...logins.map((l) => authors.get(l))]) ?? names[0] ?? k, names, logins });
  }
  for (const login of alone) out.push({ id: `gh:${login}`, label: pick([authors.get(login)]) ?? login, names: [], logins: [login] });
  // Never two entries under one label: a GitHub login tells them apart.
  const seen = new Map<string, number>();
  for (const m of out) seen.set(m.label, (seen.get(m.label) ?? 0) + 1);
  for (const m of out) if ((seen.get(m.label) ?? 0) > 1 && m.logins.length > 0) m.label = `${m.label} (@${m.logins[0]})`;
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** Is this node the member's — assigned to them, or carrying a PR they opened? */
export function memberMatches(n: Pick<SprintGraphNode, 'assignee' | 'prs'>, m: Pick<SprintMember, 'names' | 'logins'>): boolean {
  if (n.assignee != null && m.names.includes(n.assignee.name)) return true;
  return n.prs.some((p) => p.author != null && m.logins.includes(p.author.login));
}
