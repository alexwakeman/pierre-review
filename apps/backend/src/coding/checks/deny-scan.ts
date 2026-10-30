// THE DENY SCAN (docs/SECURITY.md § Sandboxed checks): a CONSERVATIVE read of a declared script's
// text before Limn will offer it as a check. It is the SECOND line, not the boundary — the OS sandbox
// (sandbox.ts) is what confines a check that slips past it. Its job is to refuse, up front and in plain
// words, a script whose text plainly does something a check must never do: build or start containers,
// pipe a download into a shell, escalate, delete outside the tree, publish or push.
//
// What it does NOT refuse: a script that merely TALKS to services on localhost (a test that expects a
// database the reader started with Docker). Starting the containers is the reader's job, not a check's.
//
// Pure: text in, a reason out. Node built-ins only.

export interface DenyRule {
  /** Matched against the normalised script text (line continuations joined, whitespace collapsed). */
  re: RegExp;
  /** The plain reason the reader sees: "It runs docker build." */
  reason: string;
}

// A word boundary that also treats `&&`, `;`, `|`, `(` and backticks as the start of a command.
const CMD = String.raw`(?:^|[\s;&|(\x60]|\$\()`;

export const DENY_RULES: readonly DenyRule[] = [
  // Containers: building, running, starting, pulling or pushing images. Talking to a running service
  // on localhost is fine; creating one from a check is not (it needs the Docker socket, which the
  // sandbox does not give, and a container is a way out of it).
  {
    re: new RegExp(`${CMD}(?:docker|podman|nerdctl)\\s+(?:[\\w-]+\\s+)*?(?:build|buildx|run|create|exec|start|pull|push|load|import|compose\\s+(?:[\\w-]+\\s+)*?(?:up|run|start|create|build|pull|exec))\\b`, 'i'),
    reason: 'It starts or builds containers.',
  },
  { re: new RegExp(`${CMD}docker-compose\\s+(?:[\\w-]+\\s+)*?(?:up|run|start|create|build|pull|exec)\\b`, 'i'), reason: 'It starts or builds containers.' },
  // A download piped into an interpreter.
  {
    re: /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b|\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:python[\d.]*|node|perl|ruby)\b/i,
    reason: 'It pipes a download into a shell.',
  },
  { re: /(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b|(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i, reason: 'It runs a downloaded script.' },
  // Privilege escalation.
  { re: new RegExp(`${CMD}(?:sudo|doas|pkexec)\\b`, 'i'), reason: 'It uses sudo.' },
  { re: new RegExp(`${CMD}su\\s+(?:-|\\w)`, 'i'), reason: 'It switches user.' },
  // Recursive delete of anything that is not plainly inside the tree: an absolute path, the home
  // folder, a variable (its value is not known here) or a parent folder.
  {
    re: new RegExp(`${CMD}(?:rm\\s+(?:-[a-zA-Z]*\\s+)*-[a-zA-Z]*[rR][a-zA-Z]*(?:\\s+-[a-zA-Z]+)*|rimraf|del-cli|trash)\\s+(?:[^\\s;&|]+\\s+)*?["']?(?:/|~|\\$|\\.\\.(?:/|\\s|$|["']))`, 'i'),
    reason: 'It deletes files outside the project.',
  },
  // Publishing and pushing.
  {
    re: new RegExp(`${CMD}(?:npm|pnpm|yarn|bun)\\s+(?:[\\w-]+\\s+)*?(?:publish|npm\\s+publish|dist-tag|deprecate|unpublish|owner|token|adduser|login)\\b`, 'i'),
    reason: 'It publishes a package.',
  },
  { re: new RegExp(`${CMD}(?:cargo\\s+(?:publish|yank|login|owner)|twine\\s+upload|gem\\s+push|poetry\\s+publish|flit\\s+publish|hatch\\s+publish|uv\\s+publish|vsce\\s+publish|ovsx\\s+publish|changeset\\s+publish|lerna\\s+publish|semantic-release|np\\s)`, 'i'), reason: 'It publishes a package.' },
  { re: new RegExp(`${CMD}(?:mvn|mvnw|\\./mvnw)\\s+(?:[\\w:.=-]+\\s+)*?deploy\\b|${CMD}(?:gradle|gradlew|\\./gradlew)\\s+(?:[\\w:.=-]+\\s+)*?publish\\w*`, 'i'), reason: 'It publishes a package.' },
  { re: new RegExp(`${CMD}git\\s+(?:-[\\w.=-]+\\s+|-C\\s+\\S+\\s+)*(?:push|remote\\s+(?:add|set-url)|config\\s+(?:--global|--system)|credential)\\b`, 'i'), reason: 'It pushes to git or changes git settings.' },
  { re: new RegExp(`${CMD}gh\\s+(?:release|pr|repo|secret|auth|api|workflow|gist)\\b`, 'i'), reason: 'It talks to GitHub.' },
  // Remote shells and copies.
  { re: new RegExp(`${CMD}(?:ssh|scp|sftp|rsync\\s+[^;&|]*\\w@?[\\w.-]+:)`, 'i'), reason: 'It connects to another machine.' },
  // Machine settings, keychains, schedulers.
  {
    re: new RegExp(`${CMD}(?:security\\s+(?:find|dump|export|unlock)|launchctl|systemctl|crontab|osascript|defaults\\s+write|chown\\s|chmod\\s+[0-7]*[67][0-7]*\\s+/|mkfs|diskutil|dd\\s+if=|shutdown|reboot)`, 'i'),
    reason: 'It changes machine settings.',
  },
  // Writing into the home folder's secrets or shell start-up.
  { re: /(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|npmrc|netrc|config\/gh|docker|kube|bashrc|zshrc|profile|bash_profile)/i, reason: 'It reads or writes your home folder’s settings.' },
  // eval of a computed string: nothing above can see what it runs.
  { re: new RegExp(`${CMD}eval\\s+["']?\\$`, 'i'), reason: 'It runs a command built at run time.' },
];

/** Line continuations joined and whitespace collapsed, so a rule cannot be dodged by a line break. */
export function normaliseScript(text: string): string {
  return text
    .replace(/\\\r?\n/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** The first rule a script's text breaks, as a plain sentence, or null when none does. */
export function denyReason(text: string): string | null {
  const t = normaliseScript(text);
  for (const line of t.split(/\r?\n/)) {
    for (const rule of DENY_RULES) if (rule.re.test(line)) return rule.reason;
  }
  return null;
}
