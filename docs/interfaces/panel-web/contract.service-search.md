---
id: panel-web
layer: interface
status: active
version: 35
updated: 2026-09-26
---

# Contract — panel-web: finding a service on My services (F-307-n, F-307-q)

A topic file of [contract.my-services.md](contract.my-services.md). The one
box above the list on `/services`, `_components/ServiceSearch.tsx` inside
`_components/MyServicesView.tsx`, over
`_hooks/useGrantsPage.ts`. It finds a *service*; the box inside a row that
narrows one service's configs is that contract's rule 18 (F-307-l).

## Rules

1. **A service is found by its own name or its configs', and billing finds
   it** (F-307-n over billing's `q`, F-307-m; the service's own name since
   F-307-x). The box shows once there is a service or a search.
   A name is written to `?q=` beside `?page=`/`?all=1` when typing rests (a
   `replace`, back to page 1), so it survives a reload and can be sent to
   support; paging and "show ended" keep it. The filter is billing's: a page of
   20 filtered here would come back short. No match names the query — never
   "no services". ي/ك fold (F-307-o).
2. **A pasted config is a credential, so it never reaches the URL** (F-307-q
   over billing's `by-lines`, F-307-p; user 2026-09-26: same box, detected by
   `://`). A paste holding `://` is read from the clipboard's own text — a
   one-line box drops line breaks and would run two links together — split on
   line breaks and spaces, each piece holding `://` once, over 4096 dropped,
   the first 20 kept with a sentence saying so (`_lib/my-services.ts`
   `pastedLines`). The lines live in the page's state only and go to billing
   in a POST body; the box shows how many, never the links. A paste replaces a
   name search and goes to page 1; paging and "show ended" keep it. Typing a
   name, clearing, Escape or a name arriving in the URL drop it, and a reload
   forgets it. A `://` that arrives without a paste (a drop) is the same paste,
   and one holding no config is refused, so `?q=` never carries a link. A subscription link (`…/sub/<token>`) is pasted the same way and finds its service by billing's token match (F-307-r); the box counts "links", either kind. No
   match says none of the pasted configs is theirs. A 429 from its own bucket
   (60 per 900s) is the page's failed-read sentence with retry
   ([contract.errors.md](contract.errors.md)).
3. **Typing never blanks the box, and redraws only the box** (user,
   2026-09-26: "the start of the text vanishes, then comes back"). What is
   typed lives in `ServiceSearch`; the page and its (memoised) rows move only
   when a settled word reaches the URL. The page remembers each search it
   wrote until the URL shows it: the URL catching up with one — late, or
   while a later word is typed — leaves the box alone; only a move it did not
   write (back, forward, a link) resets the box and drops a paste. The box is
   48px tall with 16px text, so a phone does not zoom into it.

## Proof

`services/search.test.tsx` — F-307-n: the URL's `q` asked for, a settled
write at page 1, paging and "show ended" keeping it, the no-match sentence.
F-307-q: `pastedLines` splitting, dedupe, the 4096 drop and the 20 cap; the
lines handed to billing and none of them, nor `q=`, in any URL written; the
count shown; paging and "show ended" keeping them; the capped sentence; the
pasted no-match sentence; clear, Escape and typing a name each dropping them;
a drop read as a paste; a subscription link handed over the same way. Rule 3: a late or overtaken write leaving the box and a
paste alone, back/forward still resetting it, typing not re-rendering the page.
`useGrantsPage.test.ts` hands `q` to billing's list and
pasted lines to `by-lines`, never as `q`.

