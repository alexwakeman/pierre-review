import type { FastifyInstance } from 'fastify';
import { listUsers } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// GitHub actor metadata for the Members panel / avatars.
//
// `users` is a GLOBAL table (a login is the same person for every tenant), but the LISTING is
// account-scoped: `listUsers(accountId)` returns only actors that appear in the caller's own
// synced data. Unscoped, this route handed any tenant the login, display name and avatar of
// every user any other tenant had ever synced — including contributors to private repos the
// caller cannot see.
//
// `PATCH /api/users/:id` was REMOVED. It called `setUserBot(id, isBot)`, which wrote the
// `isBot` + sticky `isBotOverridden` flags to the global row with no ownership check, so one
// account could permanently reclassify any enumerable user id for every other tenant. It had
// no frontend caller — bot classification goes through the account-scoped
// `PATCH /api/bot-reviewers/:userId` (api/routes/bot-triage.ts), which writes the per-account
// `bot_review_classification` table. See the note in db/queries.ts.
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async (req) => listUsers(accountIdOf(req)));
}
