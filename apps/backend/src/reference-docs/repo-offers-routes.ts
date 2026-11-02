import type { FastifyInstance } from 'fastify';
import type {
  RepoDocsCheckBody,
  RepoDocsCheckResponse,
  RepoDocsOffersAddResponse,
  RepoDocsOffersBody,
  RepoDocsOffersDismissResponse,
} from '@pierre-review/shared';
import { config } from '../config.js';
import type { AgentContext } from '../review/agent-context.js';
import { AGENTIC_AI_ENABLED } from '../review/claude-review/manager.js';
import { checkWorkspaceRepoFolders } from './repo-offers.js';
import { claimOffer, declineOffers, getOffer, inLibrary, libraryGithubFolders, releaseOffer, setOfferDoc } from './repo-offers-store.js';
import { addGithubFolderDoc, requestSignal, type WikiRouteHelpers } from './wiki/routes.js';

// THE DOCS OFFERS' ROUTES (docs/API.md § Reference docs → Docs offered from your repositories). The list
// itself rides `GET /api/docs` (`offers`) and `GET /api/attention` (`docsOffers`), so neither page
// fetches anything of its own on mount.
//
//   POST /api/docs/offers/check    { workspaceId? } the wizard's "From your repositories": the SAME check
//                                  over the workspace's repositories, stored scans reused, ≤
//                                  DOCS_FROM_REPOS_SCAN_MAX repositories looked at on GitHub → search + read
//   POST /api/docs/offers/add      { workspaceId?, ids, from? } the reader's yes (the card, or the wizard
//                                  with from: 'wizard'): each folder is added exactly as the wizard adds a
//                                  GitHub folder, its build queued                         → search + ai + ai_hourly
//   POST /api/docs/offers/dismiss  { workspaceId?, ids } "Not now": hides the card for
//                                  DOCS_OFFER_SNOOZE_DAYS                                   → read
//
// ⚠ NOTHING IS BUILT WITHOUT THE ADD. Each offer is CLAIMED (offered / declined → added, compare-and-set)
// before GitHub is read or a build queued, so a double press adds one document; a failed add puts it back.
// The wizard may also re-add a folder whose earlier document was removed ('added', not in the library):
// that claim holds a per-offer lock across the whole add, so a double press still adds one document.
// TENANCY: the body's `workspaceId` resolves as the library's (unknown ⇒ the Default); an offer id
// resolves only within (account, workspace) — another's reads as "no longer on offer".

const MAX_IDS = 20;

const body = {
  type: 'object',
  required: ['ids'],
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'integer', minimum: 1 },
    ids: { type: 'array', minItems: 1, maxItems: MAX_IDS, items: { type: 'integer', minimum: 1 } },
    from: { type: 'string', enum: ['card', 'wizard'] },
  },
};

const checkBody = {
  type: 'object',
  additionalProperties: false,
  properties: { workspaceId: { type: 'integer', minimum: 1 } },
};

/** Offers being added right now (one process): the wizard's re-add of an 'added' row relies on it. */
const adding = new Set<number>();

export function registerRepoOffersRoutes(app: FastifyInstance, ctx: AgentContext, h: WikiRouteHelpers): void {
  app.post('/api/docs/offers/check', { schema: { body: checkBody } }, async (req, reply): Promise<RepoDocsCheckResponse | { error: string; message: string }> => {
    if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const b = (req.body ?? {}) as RepoDocsCheckBody;
    const workspaceId = await h.workspaceOf(accountId, b.workspaceId);
    const res = await checkWorkspaceRepoFolders(accountId, workspaceId);
    return {
      workspaceId,
      folders: res.folders,
      notLookedAt: res.notLookedAt,
      unreadable: res.unreadable,
      budgetUsd: config.docsBuildBudgetUsd,
    };
  });

  app.post('/api/docs/offers/add', { schema: { body } }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const b = req.body as RepoDocsOffersBody;
    const workspaceId = await h.workspaceOf(accountId, b.workspaceId);
    const pre = await h.preflight(ctx, accountId, reply);
    if (pre) return pre;
    const out: RepoDocsOffersAddResponse = { added: [], failed: [] };
    const r = requestSignal(reply);
    try {
      const wizard = b.from === 'wizard';
      for (const id of [...new Set(b.ids)]) {
        const offer = await getOffer(accountId, workspaceId, id);
        if (offer?.tooLarge) {
          out.failed.push({ offerId: id, message: 'This folder is too large for one document. Add part of it with +.' });
          continue;
        }
        if (offer && inLibrary(`${offer.owner}/${offer.name}`, offer.path, await libraryGithubFolders(accountId, workspaceId))) {
          out.failed.push({ offerId: id, message: 'This folder is already in Docs.' });
          continue;
        }
        if (!offer || adding.has(id) || !(await claimOffer(accountId, workspaceId, id, new Date(), { reclaimAdded: wizard }))) {
          out.failed.push({ offerId: id, message: 'This folder is no longer on offer.' });
          continue;
        }
        adding.add(id);
        const back = { state: offer.state, decidedAt: offer.decidedAt ?? null };
        try {
          const res = await addGithubFolderDoc(ctx, h, {
            accountId,
            workspaceId,
            owner: offer.owner,
            repo: offer.name,
            path: offer.path,
            signal: r.signal,
          });
          if (!res.ok) {
            await releaseOffer(accountId, id, back);
            out.failed.push({ offerId: id, message: res.message });
            continue;
          }
          await setOfferDoc(accountId, id, res.row.id);
          out.added.push({ offerId: id, docId: res.row.id });
        } catch (err) {
          await releaseOffer(accountId, id, back);
          throw err;
        } finally {
          adding.delete(id);
        }
      }
    } finally {
      r.done();
    }
    reply.status(out.added.length > 0 ? 202 : 200);
    return out;
  });

  app.post('/api/docs/offers/dismiss', { schema: { body } }, async (req, reply): Promise<RepoDocsOffersDismissResponse | { error: string; message: string }> => {
    if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const b = req.body as RepoDocsOffersBody;
    const workspaceId = await h.workspaceOf(accountId, b.workspaceId);
    return { dismissed: await declineOffers(accountId, workspaceId, b.ids) };
  });
}
