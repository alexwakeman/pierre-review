import type { FastifyInstance } from 'fastify';
import type {
  ReactionContent,
  ReactionLookupBody,
  ReactionLookupResponse,
  ReactionState,
  ReactionTargetKind,
  ReactionWriteBody,
  ReactionWriteResponse,
} from '@pierre-review/shared';
import { getAccessToken } from '../../auth/account.js';
import {
  resolveReactionTarget,
  resolveReactionTargets,
} from '../../db/reaction-targets.js';
import { isRateLimitError } from '../../github/client.js';
import { setReaction } from '../../github/mutations.js';
import { noteLimited } from '../../github/rate-budget.js';
import { fetchReactionsForNodes, REACTION_NODE_BATCH } from '../../github/reactions.js';
import { accountIdOf } from '../plugins/auth.js';

// Emoji reactions on comments, review bodies and PR comments (CORE, free tier).
//
// TWO routes, both GitHub-live, NOTHING stored:
//   POST /api/reactions/lookup   the BATCHED read — many targets, one GraphQL call
//   POST /api/reactions          toggle one reaction, returns the authoritative new state
//
// WHY THE READ IS A POST. It carries a list, not an id, and a query string of 90 node
// references is neither readable nor reliably under a URL length limit. The precedent is
// `POST /api/prs/:id/refresh` — a mutating VERB with GET-shaped cost — and the same two
// reasons apply: the body is the natural place for the payload, and the cross-origin guard
// (which only inspects state-changing methods) keeps applying. Its rate-limit tier is spelled
// out EXPLICITLY in api/plugins/rate-limit.ts rather than inherited, because "it looks like a
// read" is exactly how a route that spends GitHub quota ends up on the 600/min blanket bucket.
//
// WHY NOT SYNC THEM. Adding `reactionGroups` to the fat walk query measures 0 extra GraphQL
// points but ~+32.5% response bytes on EVERY page of EVERY repo forever, and reactions have no
// `updatedAt` and no webhook we subscribe to — so the synced copy would be both more expensive
// and staler than fetching on demand. The batching that makes on-demand viable lives on the
// client (apps/frontend/src/hooks/useReactions.ts): every mounted comment registers itself, a
// tick's worth of registrations flush as ONE call here. That is why the Feed — which spans
// many PRs — costs one request rather than N.
//
// BOTH routes take part in the per-account RATE BUDGET (github/rate-budget.ts). The lookup
// consults it, feeds it, and DEGRADES TO EMPTY when the window is exhausted — a decoration
// that quietly does not render beats a 502 on a request the user never knowingly made, and
// "absent" already means "unknown" on this wire. The toggle still errors (a deliberate click
// must not silently do nothing) but reports the limit to the same budget.

/**
 * Hard ceiling on one lookup. The client batches at a smaller size; this bounds what a
 * hand-rolled caller can ask for in a single request, and the handler chunks whatever it gets
 * into REACTION_NODE_BATCH-sized GraphQL calls (GitHub's `nodes(ids:)` caps at 100).
 */
const MAX_TARGETS = 200;

const TARGET_KINDS: ReactionTargetKind[] = ['review_comment', 'pr_comment', 'review'];
const CONTENTS: ReactionContent[] = [
  'thumbs_up',
  'thumbs_down',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
];

const targetRefSchema = {
  type: 'object',
  required: ['kind', 'id'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: TARGET_KINDS },
    id: { type: 'integer', minimum: 1 },
  },
};

const lookupSchema = {
  body: {
    type: 'object',
    required: ['targets'],
    additionalProperties: false,
    properties: {
      targets: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TARGETS,
        items: targetRefSchema,
      },
    },
  },
};

const writeSchema = {
  body: {
    type: 'object',
    required: ['kind', 'id', 'content', 'add'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: TARGET_KINDS },
      id: { type: 'integer', minimum: 1 },
      content: { type: 'string', enum: CONTENTS },
      add: { type: 'boolean' },
    },
  },
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function reactionRoutes(app: FastifyInstance): Promise<void> {
  // ---- The batched read ----
  //
  // Ownership is resolved FIRST, against the local database, and only the surviving node ids
  // reach GitHub: an id list from a client must never become a way to spend this account's
  // GraphQL budget on nodes it does not own, nor an existence oracle over another tenant's
  // content. A target that does not resolve is silently absent from the response — "no
  // reactions", "deleted upstream" and "not yours" all render identically (nothing), so
  // distinguishing them would leak without buying the UI anything.
  app.post(
    '/api/reactions/lookup',
    { schema: lookupSchema },
    async (req, reply): Promise<ReactionLookupResponse | { error: string; message: string }> => {
      const { targets } = req.body as ReactionLookupBody;
      const accountId = accountIdOf(req);

      const resolved = await resolveReactionTargets(accountId, targets);
      if (resolved.length === 0) {
        return { results: [], generatedAt: new Date().toISOString() };
      }

      // One local row per node id within an account (the comment uniques are composite with
      // pr_id and a comment belongs to exactly one PR), but map to a LIST anyway so a future
      // duplicate cannot silently drop a target.
      const byNode = new Map<string, Array<{ kind: ReactionTargetKind; id: number }>>();
      for (const r of resolved) {
        const list = byNode.get(r.nodeId);
        if (list) list.push({ kind: r.kind, id: r.id });
        else byNode.set(r.nodeId, [{ kind: r.kind, id: r.id }]);
      }

      try {
        const token = await getAccessToken(accountId);
        const results: ReactionState[] = [];
        // A rate-limited token degrades to an EMPTY answer rather than a 502 (see
        // github/reactions.ts): every absent target already means "unknown" on the wire and
        // renders as no bar, so a decoration silently missing beats erroring a request the
        // user did not knowingly make. Recorded here — the one place that can log it — so
        // "the reaction bars vanished" is diagnosable rather than mysterious.
        // One mutable record rather than two `let`s: TypeScript narrows a `let` assigned only
        // inside a callback down to its initializer's type, so a later `resumeAt.toISOString()`
        // is a compile error on `never`. A property read is re-widened by the intervening call.
        const limit: { hit: boolean; resumeAt: Date | null } = { hit: false, resumeAt: null };
        for (const ids of chunk([...byNode.keys()], REACTION_NODE_BATCH)) {
          const states = await fetchReactionsForNodes(token, ids, {
            accountId,
            onPartial: (errors) => {
              // Partial GitHub errors are EXPECTED here (a node in a repo the token lost
              // access to). They cost that node its bar and nothing else — never the whole
              // batch.
              req.log.debug({ errors }, 'partial GraphQL response for reaction lookup');
            },
            onRateLimited: (at) => {
              limit.hit = true;
              limit.resumeAt = at;
            },
          });
          for (const s of states) {
            for (const ref of byNode.get(s.nodeId) ?? []) {
              results.push({
                kind: ref.kind,
                id: ref.id,
                groups: s.groups,
                viewerCanReact: s.viewerCanReact,
              });
            }
          }
          // The window will not reopen between two chunks of one request — stop asking
          // instead of spending the remaining chunks on the same refusal. Whatever earlier
          // chunks DID answer is still returned; the rest are simply absent.
          if (limit.hit) break;
        }
        if (limit.hit) {
          req.log.debug(
            { resumeAt: limit.resumeAt?.toISOString() ?? null },
            'reaction lookup degraded to empty — GitHub rate limit',
          );
        }
        return { results, generatedAt: new Date().toISOString() };
      } catch (err) {
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // ---- The toggle ----
  //
  // `add:false` removes. GitHub's mutations are idempotent on both sides (adding one you
  // already have, removing one you never had), so a double click cannot desynchronise the
  // count — which is what lets the client update optimistically and simply overwrite with
  // this response.
  //
  // No local stamp, because nothing is stored: the mutation payload's `subject` carries the
  // fresh group set, so this response IS the post-write truth. That satisfies the house rule
  // (a GitHub write must stamp or confirm, never promise "on the next sync") in its easiest
  // form — there is no next sync for reactions.
  app.post(
    '/api/reactions',
    { schema: writeSchema },
    async (req, reply): Promise<ReactionWriteResponse | { error: string; message: string }> => {
      const { kind, id, content, add } = req.body as ReactionWriteBody;
      const accountId = accountIdOf(req);

      const target = await resolveReactionTarget(accountId, { kind, id });
      if (!target) {
        reply.status(404);
        return { error: 'NotFound', message: `${kind} ${id} not found` };
      }

      try {
        const token = await getAccessToken(accountId);
        const gh = await setReaction(token, target.nodeId, content, add);
        return { kind, id, groups: gh.groups, viewerCanReact: gh.viewerCanReact };
      } catch (err) {
        // Unlike the lookup, the toggle does NOT degrade quietly: a click the user made on
        // purpose must not silently do nothing. But a rate limit discovered HERE is still a
        // fact about the whole token, so the shared budget is told either way — that is what
        // makes the next lookup skip itself instead of re-discovering the same 403.
        const rl = isRateLimitError(err);
        if (rl.limited) noteLimited(accountId, rl.resumeAt);
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
