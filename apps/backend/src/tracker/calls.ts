import { maybeAdapterFor } from './registry.js';
import type { WorkspaceTrackerAccess } from './settings.js';
import type { JiraTransport } from './jira/fetch.js';
import type { GithubCallAccess, TrackerCall } from './types.js';

// "May this workspace's tracker be READ, and with what?" — the one preparation step the worker,
// the ticket routes and the connection check share. A provider with no reader answers NotJira-style
// refusals; a reading provider needs a valid site root and, when
// its credential is a token, a token that opens.
//
// The error codes are the plugin's (NotJira / NoJiraUrl / NoJiraToken / JiraTokenUnreadable),
// kept for behaviour; the sentences name the provider through its adapter.

export type PreparedCall =
  | { ok: true; call: TrackerCall }
  | { ok: false; status: number; error: string; message: string };

export const MSG_NO_READING_TRACKER =
  'This workspace’s issue tracker is not one Limn reads. Set Jira, GitHub Issues or Linear in Settings.';

export function prepareTrackerCall(
  access: WorkspaceTrackerAccess,
  // `github`: the account's GitHub access (`githubAccessFor`) — required by GitHub Issues, ignored
  // by every other provider.
  opts: { cloud: boolean; transport?: JiraTransport; github?: GithubCallAccess },
): PreparedCall {
  const adapter = maybeAdapterFor(access.issue.provider);
  if (adapter?.reader == null || access.issue.provider == null) {
    return { ok: false, status: 400, error: 'NotJira', message: MSG_NO_READING_TRACKER };
  }
  if (access.issue.provider === 'github' && opts.github == null) {
    return { ok: false, status: 503, error: 'NoGithubAccess', message: 'Limn cannot reach GitHub as this account here.' };
  }
  const label = adapter.label;
  const apiRoot = adapter.siteRoot(access.issue.baseUrl);
  if (apiRoot == null) {
    return {
      ok: false,
      status: 400,
      error: 'NoJiraUrl',
      message:
        access.issue.provider === 'linear'
          ? 'The Linear workspace URL in Settings is not a linear.app address, like https://linear.app/your-workspace.'
          : `The ${label} base URL in Settings is not a valid web address.`,
    };
  }
  if (adapter.reader.credential === 'token') {
    if (access.token.state === 'none') {
      return {
        ok: false,
        status: 400,
        error: 'NoJiraToken',
        message: `No ${access.issue.provider === 'linear' ? 'Linear API key' : `${label} token`} is saved for this workspace. Add one in Settings.`,
      };
    }
    if (access.token.state === 'unreadable') {
      return {
        ok: false,
        status: 400,
        error: 'JiraTokenUnreadable',
        message: `The saved ${access.issue.provider === 'linear' ? 'Linear API key' : `${label} token`} cannot be read on this server. Save it again in Settings.`,
      };
    }
  }
  return {
    ok: true,
    call: {
      provider: access.issue.provider,
      apiRoot,
      credentials: {
        email: access.email,
        token: access.token.state === 'ok' ? access.token.token : '',
      },
      policy: { cloud: opts.cloud },
      transport: opts.transport,
      ...(access.issue.provider === 'github' ? { github: opts.github } : {}),
    },
  };
}
