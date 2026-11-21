// A SESSION'S BROWSER (docs/SANDBOX.md § The browser): a pinned headless Chromium Ensemble starts in the
// sandbox's network namespace (runtime/spec.ts `browserRunArgs`), when the reader ticks "Give the build a
// browser" at Approve, or when the agent asks (`ensemble-browser start`, over the same relay program as
// `limn-svc`, its own socket). The agent then drives it directly over the DevTools protocol at
// localhost:9222 (the image's `ensemble-browser shot` / `console`); Ensemble only starts and stops it.
//
// Docker only: a runtime without `startBrowser` answers so, in one line. Never fatal to a session.
import type { SandboxRuntime, SessionOwner } from '../runtime/types.js';
import { BROWSER_DEBUG_PORT } from '../runtime/spec.js';
import { startServicesRelay, type RelayHandler, type ServicesRelay } from '../services/relay.js';

export const BROWSER_SOCKET = '/tmp/ensemble-browser.sock';
/** How long Ensemble waits for a started browser to answer on its DevTools port. */
export const BROWSER_READY_MS = 30_000;

export type BrowserStartedBy = 'reader' | 'agent';

export interface BrowserHost {
  runtime: SandboxRuntime;
  owner: SessionOwner;
  sandbox: string;
  /** The session proxy's address, or null. */
  proxyUrl: string | null;
  /** One line for the session's conversation. */
  notice(text: string): void;
  /** Screenshots the agent just took (`ensemble-browser shot` names their paths): copy them out, checked. */
  onShots?(paths: readonly string[]): Promise<void>;
  /** Test seam: the wait between readiness probes. */
  probeEveryMs?: number;
}

type Out = (stream: 'o' | 'e', text: string) => void;

const PROBE = `fetch('http://localhost:${BROWSER_DEBUG_PORT}/json/version').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`;

export class SessionBrowser implements RelayHandler {
  private state: 'off' | 'starting' | 'on' | 'failed' = 'off';
  private starting: Promise<boolean> | null = null;
  private relay: ServicesRelay | null = null;
  private closed = false;

  constructor(private readonly host: BrowserHost) {}

  get available(): boolean {
    return typeof this.host.runtime.startBrowser === 'function';
  }

  get running(): boolean {
    return this.state === 'on';
  }

  /** Start it (once; a second call waits for the first). true when it answers on its DevTools port. */
  start(by: BrowserStartedBy): Promise<boolean> {
    if (this.closed || !this.available) return Promise.resolve(false);
    if (this.state === 'on') return Promise.resolve(true);
    this.starting ??= (async () => {
      this.state = 'starting';
      try {
        await this.host.runtime.startBrowser!({ ...this.host.owner, sandbox: this.host.sandbox, proxyUrl: this.host.proxyUrl });
        const ready = await this.waitReady();
        if (!ready) throw new Error('it did not answer');
        this.state = 'on';
        this.host.notice(by === 'reader' ? 'Ensemble started a browser for the build.' : 'The agent started a browser.');
        return true;
      } catch {
        this.state = 'failed';
        this.host.notice('The browser did not start. The build goes on without it.');
        return false;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    if (this.state === 'off') return;
    this.state = 'off';
    await this.host.runtime.stopBrowser?.(this.host.owner).catch(() => {});
  }

  private async waitReady(): Promise<boolean> {
    const until = Date.now() + BROWSER_READY_MS;
    while (Date.now() < until && !this.closed) {
      const r = await this.host.runtime.run(this.host.sandbox, ['node', '-e', PROBE], { timeoutMs: 10_000 }).catch(() => null);
      if (r?.code === 0) return true;
      await new Promise((res) => setTimeout(res, this.host.probeEveryMs ?? 500));
    }
    return false;
  }

  /** `ensemble-browser start | stop | status` (argv is DATA from the sandbox). */
  async handle(argv: readonly string[], _cwd: string, out: Out): Promise<number> {
    const verb = argv[0] ?? 'status';
    // `noted <path>…`: the CLI's own call after a shot (paths are DATA; the subject checks each one). Quiet.
    if (verb === 'noted') {
      await this.host.onShots?.(argv.slice(1, 7)).catch(() => {});
      return 0;
    }
    if (!this.available) {
      out('e', 'ensemble-browser: a browser runs only on Docker. Look at the code instead, and say so in your report.\n');
      return 1;
    }
    switch (verb) {
      case 'status':
        out('o', this.state === 'on' ? 'The browser is running. Use `ensemble-browser shot <url>`.\n' : this.state === 'starting' ? 'The browser is starting.\n' : this.state === 'failed' ? 'The browser did not start.\n' : 'No browser is running. Start one with `ensemble-browser start`.\n');
        return 0;
      case 'start': {
        if (this.state === 'on') {
          out('o', 'The browser is already running.\n');
          return 0;
        }
        out('o', 'Starting the browser (the first time, Ensemble downloads it: this can take a few minutes)…\n');
        const ok = await this.start('agent');
        out(ok ? 'o' : 'e', ok ? 'The browser is running. `localhost` in it is this sandbox.\n' : 'ensemble-browser: the browser did not start.\n');
        return ok ? 0 : 1;
      }
      case 'stop':
        await this.stop();
        out('o', 'The browser is stopped.\n');
        return 0;
      default:
        out('e', `ensemble-browser: unknown command \`${verb.slice(0, 40)}\`.\n`);
        return 2;
    }
  }

  /** The relay for `ensemble-browser start | stop | status`. */
  async startRelay(o: { onProblem?: (line: string) => void; program?: string; socket?: string } = {}): Promise<void> {
    const relay = startServicesRelay({
      runtime: this.host.runtime,
      sandbox: this.host.sandbox,
      controller: this,
      name: 'ensemble-browser',
      socket: o.socket ?? BROWSER_SOCKET,
      ...(o.program ? { program: o.program } : {}),
      ...(o.onProblem ? { onProblem: o.onProblem } : {}),
    });
    this.relay = relay;
    await relay.ready;
  }

  /** The session's end: the relay goes; the browser container goes with the session's resources. */
  close(): void {
    this.closed = true;
    this.relay?.close();
    this.relay = null;
  }
}
