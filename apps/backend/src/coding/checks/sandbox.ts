// THE OS SANDBOX a check runs in (docs/SECURITY.md § Sandboxed checks) — the boundary, where the deny
// scan is only a first read. Modelled on Claude Code's sandbox-runtime and Codex's Seatbelt policy:
//
//   macOS   `sandbox-exec` with a generated Seatbelt profile. Every path reaches the profile as a
//           `-D` PARAMETER (argv), never spliced into the profile text, so a folder name cannot
//           change the policy.
//   Linux   bubblewrap (`bwrap`), when it is installed and user namespaces work.
//   neither the check is REFUSED with a plain sentence — unless the reader set
//           LIMN_CHECKS_ALLOW_UNSANDBOXED=true, and then it runs with a warning on the run.
//
// THE POLICY (one shape, two renderings):
//   • writes: ONLY the worktree, the run's temp folder and Limn's private toolchain cache
//     (`writable`); `protectedPaths` stay read-only inside them;
//   • reads: everything outside the home folder and Limn's data folder; inside them ONLY the listed
//     folders (toolchains, the clone, the worktree, the caches) — never ~/.ssh, ~/.aws, ~/.config/gh,
//     Limn's database or its Codex sign-in …;
//     `hiddenPaths` are unreadable even inside a readable folder (~/.cargo/credentials.toml);
//   • network: 'localhost' (a check: loopback only, so a test can reach a database the reader started,
//     and nothing else — no DNS, no internet) or 'open' (the dependency step, which runs no repository
//     code); Unix sockets only inside the run's temp folder (never the Docker socket) either way;
//   • the keychain daemon is unreachable on macOS.
// Pure functions plus two cached probes. Node built-ins only.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { SandboxKind } from './types.js';

export interface SandboxPolicy {
  /** Folders the process may write (subtrees). Real paths. */
  writable: string[];
  /** Paths that stay read-only even inside a writable folder (subtrees). Real paths. */
  protectedPaths: string[];
  /**
   * Folders that go DARK — unreadable except the `readable` folders inside them: the home folder, and
   * Limn's data folder (its database, Codex home) wherever LIMN_DATA_DIR put it. Real paths.
   */
  darkRoots: string[];
  /** Folders inside the dark roots the process may read (subtrees). Real paths. */
  readable: string[];
  /** Paths never readable, even inside a readable folder (files or folders). Real paths. */
  hiddenPaths: string[];
  network: 'localhost' | 'open';
  /** macOS only: the per-user temp folder (`getconf DARWIN_USER_TEMP_DIR`), which compilers use. */
  darwinUserTemp?: string | null;
  /** macOS only: the per-user cache folder; only xcrun's own cache files inside it are writable. */
  darwinUserCache?: string | null;
}

/** A path safe to hand to either sandbox: absolute, no NUL or newline. */
export function assertSandboxPath(p: string): string {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\0\r\n]/.test(p)) throw new Error(`Not a usable sandbox path: ${JSON.stringify(p)}`);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/"]/g, '\\$&');
}

/**
 * The Seatbelt profile and its `-D` parameters. The profile text holds no path from the policy except
 * the two `getconf` folders (system answers, regex-escaped); every other path is `(param "…")`.
 */
export function seatbeltProfile(p: SandboxPolicy): { profile: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const ref = (prefix: string, list: string[]): string[] =>
    list.map((path, i) => {
      const key = `${prefix}${i}`;
      params[key] = assertSandboxPath(path);
      return `(param "${key}")`;
    });
  const writable = ref('W', p.writable);
  const protectedPaths = ref('P', p.protectedPaths);
  const readable = ref('R', p.readable);
  const hidden = ref('S', p.hiddenPaths);
  const dark = ref('D', p.darkRoots);

  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    // The keychain: no secret is fetched on a check's behalf.
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.security.agent") (global-name "com.apple.security.authhost"))',
    // Writes: nothing, then the run's own folders, then the protected paths inside them again.
    '(deny file-write*)',
    `(allow file-write* ${[
      ...writable.map((r) => `(subpath ${r})`),
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/dtracehelper")',
      '(literal "/dev/stdout")',
      '(literal "/dev/stderr")',
      '(regex #"^/dev/tty")',
      '(regex #"^/dev/fd/")',
    ].join(' ')})`,
  ];
  if (p.darwinUserTemp) lines.push(`(allow file-write* (regex #"^${regexEscape(assertSandboxPath(p.darwinUserTemp))}/"))`);
  if (p.darwinUserCache) lines.push(`(allow file-write* (regex #"^${regexEscape(assertSandboxPath(p.darwinUserCache))}/xcrun_db"))`);
  if (protectedPaths.length > 0) lines.push(`(deny file-write* ${protectedPaths.map((r) => `(subpath ${r})`).join(' ')})`);
  // Reads: the home folder is dark except the listed folders; names may still be stat'ed (a path
  // walk needs it), contents not. Hidden paths go dark again inside the readable ones.
  if (dark.length > 0) {
    lines.push(`(deny file-read* ${dark.map((r) => `(subpath ${r})`).join(' ')})`);
    lines.push(`(allow file-read* ${[...dark.map((r) => `(literal ${r})`), ...readable.map((r) => `(subpath ${r})`)].join(' ')})`);
  }
  lines.push('(allow file-read-metadata)');
  if (hidden.length > 0) lines.push(`(deny file-read* ${hidden.map((r) => `(subpath ${r})`).join(' ')})`);
  // Network.
  const tmpSockets = writable.map((r) => `(subpath ${r})`).join(' ');
  if (p.network === 'localhost') {
    lines.push(
      '(deny network*)',
      '(allow network-bind (local ip "*:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
    );
  } else {
    lines.push('(allow network*)', '(deny network-outbound (remote unix-socket))', '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))');
  }
  if (tmpSockets) {
    lines.push(`(allow network-bind (local unix-socket ${tmpSockets}))`, `(allow network-outbound (remote unix-socket ${tmpSockets}))`);
  }
  return { profile: `${lines.join('\n')}\n`, params };
}

/** The bubblewrap argv for one command (everything before the command itself). */
export function bwrapArgs(p: SandboxPolicy, cwd: string): string[] {
  const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try'];
  // A private network namespace has its OWN loopback: a check reaches nothing outside it (Linux cannot
  // reach the reader's localhost services; macOS can — docs/SECURITY.md says so).
  if (p.network === 'localhost') args.push('--unshare-net');
  args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
  // The dark roots go dark, then the readable folders come back read-only, then the writable ones.
  for (const d of p.darkRoots) args.push('--tmpfs', assertSandboxPath(d));
  for (const r of p.readable) args.push('--ro-bind-try', assertSandboxPath(r), r);
  for (const w of p.writable) args.push('--bind', assertSandboxPath(w), w);
  for (const r of p.protectedPaths) args.push('--ro-bind-try', assertSandboxPath(r), r);
  for (const h of p.hiddenPaths) {
    const path = assertSandboxPath(h);
    let dir = false;
    try {
      dir = statSync(path).isDirectory();
    } catch {
      continue; // absent: nothing to hide
    }
    if (dir) args.push('--tmpfs', path);
    else args.push('--ro-bind', '/dev/null', path);
  }
  args.push('--chdir', assertSandboxPath(cwd));
  return args;
}

/** The program and argv that run `argv` inside the sandbox (or bare, for 'none'). */
export function wrapCommand(kind: SandboxKind, p: SandboxPolicy, cwd: string, argv: string[]): { command: string; args: string[] } {
  if (argv.length === 0) throw new Error('wrapCommand: empty argv');
  if (kind === 'none') return { command: argv[0]!, args: argv.slice(1) };
  if (kind === 'bwrap') return { command: 'bwrap', args: [...bwrapArgs(p, cwd), '--', ...argv] };
  const { profile, params } = seatbeltProfile(p);
  const d: string[] = [];
  for (const [k, v] of Object.entries(params)) d.push('-D', `${k}=${v}`);
  return { command: SANDBOX_EXEC, args: ['-p', profile, ...d, '--', ...argv] };
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

let detected: { kind: SandboxKind; reason: string | null } | null = null;

/** Which sandbox this machine has. Probed once (a real no-op run, not just "the binary exists"). */
export function detectSandbox(platform: NodeJS.Platform = process.platform): { kind: SandboxKind; reason: string | null } {
  if (detected) return detected;
  if (platform === 'darwin') {
    const ok = existsSync(SANDBOX_EXEC) && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 10_000 }).status === 0;
    detected = ok ? { kind: 'seatbelt', reason: null } : { kind: 'none', reason: 'macOS’s sandbox-exec did not start here.' };
  } else if (platform === 'linux') {
    const bwrap = findOnPath('bwrap');
    if (!bwrap) detected = { kind: 'none', reason: 'Install bubblewrap (bwrap) to run tests in a sandbox.' };
    else {
      const ok = spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-net', '--', '/bin/true'], { timeout: 10_000 }).status === 0;
      detected = ok ? { kind: 'bwrap', reason: null } : { kind: 'none', reason: 'bubblewrap is installed but cannot start a sandbox here (user namespaces may be off).' };
    }
  } else detected = { kind: 'none', reason: 'Tests run in a sandbox only on macOS and Linux.' };
  return detected;
}

/** For tests. */
export function resetSandboxDetection(): void {
  detected = null;
}

/** An executable on PATH, or null. */
export function findOnPath(name: string, path: string = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* next */
    }
  }
  return null;
}

/** macOS: the per-user temp and cache folders (`getconf`), or nulls elsewhere / on failure. */
export function darwinUserFolders(platform: NodeJS.Platform = process.platform): { temp: string | null; cache: string | null } {
  if (platform !== 'darwin') return { temp: null, cache: null };
  const read = (key: string): string | null => {
    const r = spawnSync('/usr/bin/getconf', [key], { encoding: 'utf8', timeout: 5_000 });
    const v = r.status === 0 ? r.stdout.trim() : '';
    if (!v.startsWith('/')) return null;
    try {
      return realpathSync(v); // Seatbelt matches REAL paths (/var → /private/var)
    } catch {
      return null;
    }
  };
  return { temp: read('DARWIN_USER_TEMP_DIR'), cache: read('DARWIN_USER_CACHE_DIR') };
}
