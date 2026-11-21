// A SESSION'S TICKET RELAY (docs/SANDBOX.md § The ticket relay): `ensemble-ticket` in the sandbox → the
// same relay program as `limn-svc` (its own socket) → TicketRelayController on the host. Started by the
// session machine for a story session once the repositories are in; never fatal (the client then says
// the ticket is not available, and TICKET.md still holds the ticket).
//
// ⚠ `tracker/runtime.ts` opens the DB at import: every tracker import here is LAZY.
import type { SandboxNetworkEntry } from '@pierre-review/shared';
import type { ManifestEntry } from '../../tracker/artifacts.js';
import type { SandboxRuntime } from '../runtime/types.js';
import { startServicesRelay, type ServicesRelay } from '../services/relay.js';
import { TicketRelayController, type TicketRelaySource } from './controller.js';

export { TicketRelayController, TICKET_DIR, TICKET_USAGE } from './controller.js';
export type { TicketRelaySource, TicketRelayIo } from './controller.js';

export const TICKET_SOCKET = '/tmp/ensemble-ticket.sock';

export interface TicketRelay {
  controller: TicketRelayController;
  close(): void;
}

export async function startTicketRelay(o: {
  runtime: SandboxRuntime;
  sandbox: string;
  root: string;
  source: TicketRelaySource;
  onNetwork?: (e: SandboxNetworkEntry) => void;
  onProblem?: (line: string) => void;
  /** Test seams. */
  program?: string;
  socket?: string;
}): Promise<TicketRelay> {
  const controller = new TicketRelayController(o.root, o.source, {
    write: (files) => o.runtime.copyIn(o.sandbox, files),
    ...(o.onNetwork ? { onNetwork: o.onNetwork } : {}),
  });
  const relay: ServicesRelay = startServicesRelay({
    runtime: o.runtime,
    sandbox: o.sandbox,
    controller,
    name: 'ensemble-ticket',
    socket: o.socket ?? TICKET_SOCKET,
    ...(o.program ? { program: o.program } : {}),
    ...(o.onProblem ? { onProblem: o.onProblem } : {}),
  });
  await relay.ready;
  // The manifest is read now, so `.limn/ticket/manifest.json` is there before the first turn.
  await controller.manifest();
  return { controller, close: () => relay.close() };
}

/** The ticket's text the manifest scans (the session's own copy: no tracker read). */
export interface TicketTextForManifest {
  ident: string;
  description: string;
  comments: string | null;
}

/** The real source: the workspace's tracker, read on the host. */
export function trackerTicketRelaySource(o: {
  accountId: number;
  workspaceId: number;
  ticket: () => TicketTextForManifest;
  refreshTicket: () => Promise<string | null>;
}): TicketRelaySource {
  let access: Promise<import('../../tracker/ticket-artifacts.js').TicketArtifactAccess> | null = null;
  let host = 'tracker';
  const open = () => {
    access ??= (async () => {
      const [{ trackerContext }, { ticketArtifactAccess }] = await Promise.all([import('../../tracker/runtime.js'), import('../../tracker/ticket-artifacts.js')]);
      const a = await ticketArtifactAccess(trackerContext(), o.accountId, o.workspaceId, o.ticket().ident);
      host = a.host;
      return a;
    })();
    return access;
  };
  return {
    host: () => host,
    async manifest() {
      const [{ buildManifest }, { artifactErrorSentence }] = await Promise.all([import('../../tracker/artifacts.js'), import('../../tracker/ticket-artifacts.js')]);
      const t = o.ticket();
      let problem: string | null = null;
      let provider = 'tracker';
      let attachments: Awaited<ReturnType<import('../../tracker/ticket-artifacts.js').TicketArtifactAccess['attachments']>> = [];
      try {
        const a = await open();
        provider = a.provider;
        attachments = await a.attachments();
      } catch (e) {
        access = null;
        problem = `Attachments were not read: ${artifactErrorSentence(e)}`;
      }
      return { entries: buildManifest({ provider, attachments, description: t.description, comments: t.comments }), problem };
    },
    async download(entry: ManifestEntry) {
      const { artifactErrorSentence } = await import('../../tracker/ticket-artifacts.js');
      try {
        return await (await open()).download(entry.fetch);
      } catch (e) {
        throw new Error(artifactErrorSentence(e));
      }
    },
    refreshTicket: o.refreshTicket,
  };
}
