// THE HOST SIDE OF THE SERVICES RELAY (docs/SANDBOX.md § Services). Limn starts `limn-svcd`
// (apps/backend/sandbox-image/limn-svcd.cjs) INSIDE the sandbox with `runtime.exec` and talks to it over
// that process's stdin/stdout, one JSON object per line. So:
//
//   • nothing on the host listens for the sandbox (no port, no socket: a sandbox can never connect out
//     to Limn), and the reverse direction is the `docker exec` Limn already owns;
//   • `limn-svc` in the sandbox reaches the relay over a unix socket; every request is handed to the
//     controller (controller.ts), which treats it as DATA;
//   • the relay also runs the localhost forwards the controller hands it.
//
// If the relay exits while the session is open (the agent can kill its own processes), it is started
// again, a few times, and the forwards are given to it again.
import type { SandboxRuntime } from '../runtime/types.js';
import type { ServicesController } from './controller.js';
import type { Forward } from './policy.js';

export const RELAY_PROGRAM = '/usr/local/lib/limn/limn-svcd.cjs';
export const SVC_SOCKET = '/tmp/limn-svc.sock';
const MAX_RESTARTS = 5;
const MAX_CHUNK = 32 * 1024;

export interface ServicesRelay {
  /** Resolves when the relay listens (rejects when it never does). */
  ready: Promise<void>;
  close(): void;
}

type FromRelay =
  | { t: 'ready'; socket: string }
  | { t: 'req'; id: number; argv: unknown; cwd: unknown }
  | { t: 'gone'; id: number }
  | { t: 'forwards'; listening: number[]; failed: { port: number; reason: string }[] };

export function startServicesRelay(o: {
  runtime: SandboxRuntime;
  sandbox: string;
  controller: ServicesController;
  onProblem?: (line: string) => void;
  readyTimeoutMs?: number;
  /** Test seams: the relay program and its socket. */
  program?: string;
  socket?: string;
}): ServicesRelay {
  let closed = false;
  let restarts = 0;
  let current: ReturnType<SandboxRuntime['exec']> | null = null;
  let lastForwards: Forward[] = [];
  let pendingForwards: ((r: { listening: number[]; failed: { port: number; reason: string }[] }) => void)[] = [];
  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  ready.catch(() => undefined);
  let isReady = false;

  const send = (m: unknown): void => current?.write(`${JSON.stringify(m)}\n`);

  o.controller.setForwarder(
    (forwards) =>
      new Promise((resolve) => {
        lastForwards = forwards;
        if (!current) {
          resolve({ listening: [], failed: forwards.map((f) => ({ port: f.port, reason: 'the relay is not running' })) });
          return;
        }
        pendingForwards.push(resolve);
        send({ t: 'forward', ports: forwards.map((f) => ({ port: f.port, host: f.host, target: f.target })) });
      }),
  );

  const handle = (m: FromRelay): void => {
    if (m.t === 'ready') {
      if (!isReady) {
        isReady = true;
        readyResolve();
      }
      if (lastForwards.length > 0) send({ t: 'forward', ports: lastForwards.map((f) => ({ port: f.port, host: f.host, target: f.target })) });
      return;
    }
    if (m.t === 'forwards') {
      const r = { listening: Array.isArray(m.listening) ? m.listening : [], failed: Array.isArray(m.failed) ? m.failed : [] };
      const waiters = pendingForwards;
      pendingForwards = [];
      for (const w of waiters) w(r);
      return;
    }
    if (m.t === 'req' && Number.isInteger(m.id)) {
      const id = m.id;
      const argv = Array.isArray(m.argv) ? m.argv.filter((a): a is string => typeof a === 'string').slice(0, 64) : [];
      const cwd = typeof m.cwd === 'string' ? m.cwd : '';
      const out = (stream: 'o' | 'e', text: string): void => {
        for (let i = 0; i < text.length; i += MAX_CHUNK) send({ t: 'out', id, stream, data: text.slice(i, i + MAX_CHUNK) });
      };
      void o.controller
        .handle(argv, cwd, out)
        .catch((e: unknown) => {
          out('e', `limn-svc: ${e instanceof Error ? e.message : String(e)}\n`);
          return 1;
        })
        .then((code) => send({ t: 'exit', id, code }));
    }
    // `gone`: the client left; its answer is dropped by the relay.
  };

  const start = (): void => {
    const h = o.runtime.exec(o.sandbox, ['node', o.program ?? RELAY_PROGRAM], { interactive: true, env: { LIMN_SVC_SOCKET: o.socket ?? SVC_SOCKET } });
    current = h;
    void (async () => {
      let buf = '';
      let err = '';
      for await (const ev of h.events) {
        if (ev.type === 'stdout') {
          buf += ev.data.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try {
              handle(JSON.parse(line) as FromRelay);
            } catch {
              /* not one of ours */
            }
          }
        } else if (ev.type === 'stderr') {
          err = (err + ev.data.toString('utf8')).slice(-2_000);
        }
      }
      if (current === h) current = null;
      for (const w of pendingForwards.splice(0)) w({ listening: [], failed: lastForwards.map((f) => ({ port: f.port, reason: 'the relay stopped' })) });
      if (closed) return;
      if (restarts++ < MAX_RESTARTS) {
        o.onProblem?.(`The services relay stopped${err.trim() ? ` (${err.trim().split('\n').pop()})` : ''}. Starting it again.`);
        setTimeout(() => {
          if (!closed) start();
        }, 1_000).unref();
      } else {
        o.onProblem?.('The services relay keeps stopping. `limn-svc` will not answer in this session.');
        if (!isReady) readyReject(new Error('The services relay did not start.'));
      }
    })();
  };
  start();

  const timer = setTimeout(() => {
    if (!isReady) readyReject(new Error('The services relay did not start.'));
  }, o.readyTimeoutMs ?? 20_000);
  timer.unref();

  return {
    ready,
    close() {
      closed = true;
      clearTimeout(timer);
      o.controller.setForwarder(null);
      current?.end();
      current?.kill();
      current = null;
    },
  };
}
