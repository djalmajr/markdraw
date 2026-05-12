---
title: "Operations follow-ups"
audience: dev
sources:
  - in-session decision 2026-05-12
updated: 2026-05-12
tags: [operations, trademark, domain, branding, backlog]
status: stable
---

# Operations follow-ups

Items that aren't code work but require action before / right after
the public-repo launch. Captured here because Linear was unavailable
at the moment they were discussed and they shouldn't be lost.

## Trademark — register "AsciiMark"

**Why:** without a registered trademark, the only protection against
a fork that renames itself "AsciiMark Plus" / "AsciiMark Pro" is
the proprietary license (binding on code, weak on brand). The brand
is the moat once the source is visible.

**Action:**

* Brazil (INPI): file class 9 (software). ~R$ 350-700, ~12 months
  examination.
  https://www.gov.br/inpi/pt-br
* United States (USPTO): file class 9. ~US$ 350-400, ~12 months.
  Higher priority if there's any plan to sell in the US.
  https://www.uspto.gov/trademarks
* International (WIPO Madrid Protocol): only worth it after the BR
  registration goes through — uses it as the priority filing.

Until the mark is granted, every public mention of "AsciiMark" gets
a "™" superscript. After grant, it becomes "®".

## Domain — pick a permanent home

Right now the site lives on `djalmajr.github.io/asciimark`. A
dedicated domain is needed for:

* Branding (`@asciimark.com` for support email, etc.).
* Future Asciimark Sync / Publish service hosting.
* Avoid being tied to the personal GitHub handle long-term.

**Candidates** (check availability + WHOIS privacy):

* `asciimark.com` — first choice if available
* `asciimark.app` — modern alternative, .app forces HTTPS
* `asciimark.dev` — same as .app, narrower audience
* `getasciimark.com` — fallback if .com is taken
* `useasciimark.com` — fallback if .com is taken

**After purchase:**

1. CNAME from apex / `www` to GitHub Pages
2. Update `apps/site` URL refs (currently
   `djalmajr.github.io/asciimark`)
3. Update Privacy Policy + Guide / README links
4. Add `CNAME` file to the site bundle

## Source: this file replaces a Linear issue

Linear API access was disabled when these items were identified
on 2026-05-12. Once Linear is reactivated, copy this content into
two issues (trademark + domain) under the Operations or new
"Brand & Infrastructure" project and link the issues from here.
