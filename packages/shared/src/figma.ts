// FIGMA — the workspace's optional Figma token (docs/IMPLEMENT-UI-PLAN.md § 3; docs/SANDBOX.md § The ticket
// relay). With it, `ensemble-ticket figma <id>` reads a Figma frame the ticket links, on the HOST: an outline of
// its layers (no model) and a picture of it. Without it, the agent works from the ticket's other files.

// `GET /api/workspaces/:id/figma`.
export interface WorkspaceFigmaSettings {
  workspaceId: number;
  hasToken: boolean;
  /** A token is saved but cannot be opened on this server (save it again). */
  tokenUnreadable: boolean;
}

// `PUT /api/workspaces/:id/figma` — a partial patch.
export interface WorkspaceFigmaUpdate {
  /** WRITE-ONLY. Never echoed. */
  token?: string;
  clearToken?: boolean;
}

// `POST /api/workspaces/:id/figma/check` — "Test token" (the SAVED token).
export interface FigmaConnectionCheck {
  workspaceId: number;
  ok: boolean;
  message: string;
}
