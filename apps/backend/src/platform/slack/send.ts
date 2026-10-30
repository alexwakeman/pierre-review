import type { SlackMessage } from './report.js';
import { normalizeSlackWebhookUrl } from '../settings/store.js';

// POST a Block Kit message to a Slack incoming webhook. Throws on a non-2xx so the caller (cron or
// test route) can log/surface it. Uses the global fetch (Node ≥18).
//
// SSRF: the URL is re-validated HERE as well as at the point of storage. Storage-time validation
// (settings/store.ts `normalizeSlackWebhookUrl`) is the real control, but this is the function
// that actually makes the outbound request, and a row written before that validation existed —
// or by any future code path that bypasses the patch builder — would otherwise still be fetched.
// Validating at the sink makes the guarantee structural rather than dependent on call order.
//
// The response BODY is deliberately not surfaced. It used to be included in the thrown message
// (first 200 bytes), which turned a failed request into a read primitive: point the webhook at an
// internal service and the error told you what it replied. The body goes nowhere; the status code
// is enough to tell a user their webhook is wrong.
// An event signal is ONE coloured attachment and nothing above it, so its top-level `blocks` is
// empty: that key is left out rather than sent as `[]`, and `text` is then the line Slack shows
// above the bar (and in the notification).
export function slackBody(message: SlackMessage): string {
  const { blocks, ...rest } = message;
  return JSON.stringify(blocks.length > 0 ? message : rest);
}

export async function postToSlack(webhookUrl: string, message: SlackMessage): Promise<void> {
  const safeUrl = normalizeSlackWebhookUrl(webhookUrl);
  if (!safeUrl) {
    throw new Error(
      'Not a valid Slack incoming-webhook URL (expected https://hooks.slack.com/services/…).',
    );
  }
  const res = await fetch(safeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: slackBody(message),
    // Never follow a redirect: a 30x is the standard way to smuggle a request past a
    // host allowlist that was only applied to the first URL.
    redirect: 'error',
  });
  if (!res.ok) {
    throw new Error(`Slack webhook responded ${res.status}`);
  }
}
