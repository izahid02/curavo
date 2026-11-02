# Curavo website

Plain HTML, no build step, so it loads fast on a 4G phone.

| File | What it is |
|---|---|
| `index.html` | The home page: features with real screens, prices, free trial, demo booking, FAQ. |
| `privacy.html`, `terms.html`, `refund.html` | Legal pages, **generated** by `make_legal_pages.py`. Edit the text there and re-run `python3 website/make_legal_pages.py`. They are drafts until a lawyer/CA has read them. |
| `assets/img/*.webp` | Screenshots from a **demonstration shop** ("Sunrise Medicos", made-up patients). Never use a real shop's screens. |

Before going live, fill in the `SITE` block at the bottom of `index.html` (WhatsApp, email, address,
registered name, the demo-form address) and the placeholders at the top of `make_legal_pages.py`.
Anything still missing shows as a yellow `[placeholder]` on the page.

The Download button points at the Curavo cloud (`/download/windows`), which always serves the newest
version released to everyone.
