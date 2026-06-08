# Domain reputation & the Chrome "Dangerous" warning (cloud)

Some visitors — most often on **work / org-managed Chrome profiles** — hit a red
full-page **"Dangerous site"** interstitial (Google Safe Browsing) when signing in
to `https://pierre-review.com`, while the same flow on a personal profile works
fine. This doc explains why and how to clear it. It only concerns the **cloud**
deployment; local mode (`npx pierre-review`) never touches a public domain.

> The matching code-side hardening — the OAuth callback now **redirects** on any
> failure instead of dumping a raw `{"error":…}` page — lives in
> `apps/backend/src/api/routes/auth.ts`. That removes one "looks like a phishing
> page" signal and is described in [DEPLOY-RAILWAY.md](./DEPLOY-RAILWAY.md). This
> doc covers the reputation side.

---

## Why it happens (and why only on some profiles)

The red page is **Google Safe Browsing**, not your server. The profile asymmetry
is the tell:

- **Standard protection** (typical personal profile) checks a locally-cached
  blocklist. A clean new domain isn't on it → no warning.
- **Enhanced Safe Browsing** (often *forced on* by Google Workspace / Chrome
  Enterprise policy on work profiles) does **real-time reputation lookups** and
  will warn on **new, low-traffic domains it hasn't seen before** — even when they
  are not on any malware list. `pierre-review.com` is a freshly-registered domain
  with little history, so Enhanced mode treats it with suspicion.
- Some orgs additionally run their **own URL bl&#8203;ocklist** (Chrome
  `URLBlocklist` policy). That interstitial usually says *"blocked by your
  administrator"* rather than *"Dangerous"* — only the org's admin can allowlist
  it, and nothing here changes that.

A login/OAuth endpoint that returns an error body (the old callback behaviour) is
exactly the kind of thing these heuristics dislike on an unknown domain, which is
why the callback fix above matters for reputation too.

---

## Step 1 — Find out if Google *globally* flagged you

A global flag would warn **everyone**, not just work profiles. Check both:

1. **Safe Browsing Site Status** — open
   <https://transparencyreport.google.com/safe-browsing/search?url=pierre-review.com>.
   "No unsafe content found" = you're not on Google's blocklist (expected here,
   since personal profiles work). Anything else = a real flag; go to step 3.
2. **Search Console → Security & Manual Actions → Security Issues** (after
   verifying the domain, step 2). This is where a real flag shows up with a
   **Request Review** button.

If both are clean, the warning is **Enhanced-Safe-Browsing-on-a-new-domain** (or an
org blocklist). The fix is reputation + time (step 4), not a takedown appeal.

---

## Step 2 — Verify the domain in Google Search Console

Verifying unlocks the Security Issues report and lets you request reviews. Two
ways — do the **Domain property** if you can, since it covers every subdomain and
both http/https.

**Option A — Domain property (DNS TXT, preferred).** In
[Search Console](https://search.google.com/search-console) → *Add property* →
**Domain** → enter `pierre-review.com`. Google gives you a `TXT` record. The domain
was registered **through Railway**, so add it in **Railway → the domain's DNS
records** (same place the app's custom-domain records live — see
[DEPLOY-RAILWAY.md §4](./DEPLOY-RAILWAY.md)). Wait for propagation, then **Verify**.

**Option B — URL-prefix via HTML meta tag (no DNS needed).** Choose the
**URL prefix** property for `https://pierre-review.com/`, pick the **HTML tag**
method, and paste the `<meta name="google-site-verification" …>` tag into the
landing page head at `apps/landing/index.html` (alongside the existing
`<meta name="description">`). Redeploy, then **Verify**. This is the quickest path
since the landing page is already served at `/`.

---

## Step 3 — If you *are* flagged, request a review

In **Search Console → Security Issues**, read the sample flagged URLs, confirm the
site is clean (it is — read-only GitHub mirror, OAuth sign-in, no user-uploaded
content), then click **Request Review** and briefly describe the site. Turnaround
is typically a few days. Re-flagging is rare once reputation is established.

For an **Enhanced Safe Browsing false positive** specifically (no Search Console
entry, warning only on Enhanced profiles), use the **"report incorrect warning"**
link on the interstitial itself. But for a new domain, reputation-building (next
step) is the durable fix, not a one-off report.

---

## Step 4 — Build reputation so the warning fades

New-domain scrutiny eases with age, traffic, and signal hygiene:

- **Get the landing page indexed.** Verified in Search Console → submit
  `https://pierre-review.com/` for indexing. A real, crawlable marketing page (you
  have one at `/`) is a strong legitimacy signal.
- **Keep TLS clean.** Railway provisions a valid cert automatically; ensure **no
  mixed content** (the SPA calls the API with relative `/api`, so this should hold)
  and consider an **HSTS** header.
- **Don't serve error/odd bodies on auth URLs.** Already handled — the callback
  redirects on failure (step note at top). Keep it that way.
- **Single canonical host.** `www` redirects to the apex and `APP_BASE_URL` matches
  the host users land on (see [DEPLOY-RAILWAY.md §4](./DEPLOY-RAILWAY.md)), so the
  OAuth round-trip and cookies stay on one origin — fewer redirect hops for
  heuristics to distrust.

---

## What you can't fix from here

If a visitor's **organization** blocks the domain via Chrome Enterprise policy
(`URLBlocklist`) or a corporate proxy/filter, that's the org admin's allowlist —
no app-side change clears it. The warning wording ("blocked by your administrator"
vs. Safe Browsing's "Dangerous site") tells you which case you're in. For the
common Enhanced-Safe-Browsing case, steps 2–4 are the levers.
