// The story view's Jira status picker (components/Ticket/TicketStatusPicker.tsx) — THE ONE TRACKER
// WRITE. Pinned here, at the component, rendered collapsed (its state on every mount):
//   - the chip is the trigger, says the status, and announces a menu;
//   - ⚠ NOTHING IS FETCHED ON MOUNT: Jira's transitions are asked only when the picker opens.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TicketStatusPicker } from '../src/components/Ticket/TicketStatusPicker.js';
import { useFilters } from '../src/store/filters.js';

const IDENT = 'jira:https://acme.atlassian.net#PLAT-1';

function render(qc: QueryClient): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(TicketStatusPicker, { ident: IDENT, status: 'In Progress', chipClassName: 'chip' }),
    ),
  );
}

describe('TicketStatusPicker, collapsed', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    useFilters.setState({ workspaceId: 1 });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  it('is the status chip, a menu trigger, and asks Jira nothing', () => {
    const qc = new QueryClient();
    const html = render(qc);
    expect(html).toContain('In Progress');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(fetchSpy).not.toHaveBeenCalled();
    const q = qc.getQueryCache().find({ queryKey: ['ticket-transitions'], exact: false });
    expect(q == null || q.state.fetchStatus === 'idle').toBe(true);
  });
});
