// A GIT REMOTE → `owner/name` (docs/SANDBOX.md § The workspace mirror). The folder check matches a
// local clone to a workspace repository by this, case-insensitively, never by folder name.
//
// Accepted: scp-like `git@github.com:owner/name.git`, `ssh://git@github.com[:port]/owner/name`,
// `https://[user[:pass]@]github.com/owner/name(.git)(/)`, `git://…`, and SSH host aliases
// (`git@github-work:owner/name`). The host is returned but not used to match: Limn's repositories are
// GitHub's, and a reader's SSH alias names GitHub under another name.
// ⚠ The URL can carry a credential (`https://x-access-token:…@github.com/…`); it is never returned.

export interface ParsedRemote {
  host: string;
  owner: string;
  name: string;
  /** `owner/name`, lower-case: the match key. */
  slug: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

function fromPath(host: string, path: string): ParsedRemote | null {
  let p = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.endsWith('.git')) p = p.slice(0, -4);
  const parts = p.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || name === '.' || name === '..' || owner === '.' || owner === '..') return null;
  return { host: host.toLowerCase(), owner, name, slug: `${owner}/${name}`.toLowerCase() };
}

export function parseGitRemote(url: string): ParsedRemote | null {
  const u = url.trim();
  if (u === '' || u.length > 2048) return null;
  // URL forms: ssh://, https://, http://, git://, git+ssh://
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)$/i.exec(u);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    if (!['ssh', 'https', 'http', 'git', 'git+ssh', 'ssh+git'].includes(scheme)) return null;
    return fromPath(m[2]!, m[3]!);
  }
  // scp-like: [user@]host:owner/name — not a Windows drive (`C:\…`), not a local path.
  const s = /^(?:[^@/\s]+@)?([A-Za-z0-9_.-]+):(?!\/\/)(.+)$/.exec(u);
  if (s && s[1]!.length > 1) return fromPath(s[1]!, s[2]!);
  return null;
}

/** The remote a clone is matched by: `origin`, else `upstream`, else the first one. */
export function pickRemote(remotes: ReadonlyMap<string, string>): string | null {
  return remotes.get('origin') ?? remotes.get('upstream') ?? remotes.values().next().value ?? null;
}

/**
 * The `[remote "<name>"] url = …` entries of a git config file. A small INI read: sections, keys,
 * quoted values. Enough for the remote URL; anything unusual is skipped, never guessed.
 */
export function remotesFromGitConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let remote: string | null = null;
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (sec) {
      remote = sec[1]!.toLowerCase() === 'remote' && sec[2] != null ? sec[2].replace(/\\(.)/g, '$1') : null;
      continue;
    }
    if (remote == null) continue;
    const kv = /^url\s*=\s*(.*)$/i.exec(line);
    if (kv && !out.has(remote)) {
      let v = kv[1]!.trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
      out.set(remote, v);
    }
  }
  return out;
}
