---
id: marketing-web
layer: interface
updated: 2026-09-04
---

# Open questions — marketing-web

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | Is `coinsite` staying as a separate app, or folding into `site-pwa` public routes? | no | ASSUMED(2026-09-04): stays separate (apex domain, different lifecycle) | -> ADR if merged |
| 2026-09-04 | The `(Auth)` scaffolds imply login on the marketing site. Real, or leftover from the template? | no | ASSUMED(2026-09-04): leftover; auth happens on `panel-web` | -> delete or implement |
