// GITHUB'S REFUSAL OF A REVIEW REQUEST, IN PLAIN ENGLISH (POST /api/prs/:id/request-reviewers).
//
// GitHub answers 422 when it will not ask someone: most often "Reviews may only be requested from
// collaborators", i.e. the person cannot see the repo. GitHub asks NOBODY in that batch, so the words
// name everyone the request carried. The SPA sends one person per request, so in practice it names
// one person and lands on that person's chip. Any other failure stays a 502 (the route decides).
// Pure: no I/O.

/** The HTTP status a thrown GitHub REST error carries (`ghRest` attaches it), else null. */
export function githubErrorStatus(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

/** GitHub's own `message` from the thrown error's text (`… -> 422: {"message":"…"}`), else null. The
 *  body is cut at 300 characters, so this reads the field with a pattern, never JSON.parse. */
export function githubRefusalWords(errText: string): string | null {
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(errText);
  if (m == null) return null;
  const words = m[1]!.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  return words === '' ? null : words;
}

/** The sentence the reader sees for a GitHub 422. */
export function reviewRequestRefusal(args: {
  errText: string;
  logins: readonly string[];
  teamSlugs: readonly string[];
  repoFullName: string;
}): string {
  const who = [...args.logins.map((l) => `@${l}`), ...args.teamSlugs.map((t) => `@${t}`)];
  const words = githubRefusalWords(args.errText);
  if (/collaborator/i.test(words ?? args.errText)) {
    if (who.length === 1) {
      return `${who[0]} can’t be asked to review: they don’t have access to ${args.repoFullName}.`;
    }
    return `GitHub asked nobody: one of ${who.join(', ')} doesn’t have access to ${args.repoFullName}.`;
  }
  const subject = who.length === 1 ? `${who[0]} can’t be asked to review` : 'GitHub refused the request';
  return words != null ? `${subject}: ${words.replace(/\.$/, '')}.` : `${subject}.`;
}
