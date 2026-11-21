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
    // A Figma link, with the WORKSPACE's Figma token (Settings → Integrations → Figma), on the host.
    async figma(entry: ManifestEntry) {
      const f = entry.artifact.figma;
      if (f == null) throw new Error('That is not a Figma link Ensemble can read.');
      const [{ db, schema }, { readWorkspaceFigmaToken }, { readFigmaFrames }, { figmaErrorMessage }] = await Promise.all([
        import('../../db/client.js'),
        import('../../figma/settings.js'),
        import('../../figma/read.js'),
        import('../../figma/client.js'),
      ]);
      const token = await readWorkspaceFigmaToken({ db, schema: schema as unknown as Record<string, never> }, o.accountId, o.workspaceId);
      if (token.state === 'none') throw new Error('No Figma token is saved for this workspace, so Ensemble cannot read Figma. Work from the ticket\'s other files, and say so in the plan.');
      if (token.state === 'unreadable') throw new Error('The workspace\'s Figma token cannot be read on this computer. Work from the ticket\'s other files.');
      try {
        const r = await readFigmaFrames({ accountId: o.accountId, token: token.token, fileKey: f.fileKey, nodeId: f.nodeId });
        return { outline: r.outline, pngs: r.pngs, calls: r.calls };
      } catch (e) {
        throw new Error(figmaErrorMessage(e));
      }
    },
  };
}
