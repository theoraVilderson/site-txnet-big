---
id: bot-app
layer: interface
status: active
version: 15
updated: 2026-10-04
---

# Contract — bot-app: guides in the chat (F-414-f)

A topic file of [contract.md](contract.md). `flows/guide.flow.ts`, the
`📖 Guides` row on the guest and member menus (`ACTIONS.guides`),
`guide-api/guide-api.client.ts` and `guide-api/guide-media.sender.ts`. The
guides are guide's ([contract.md](../../domains/guide/contract.md)): the bot
shows what that tenant's panel shows a stranger, through the same resolver.

## Rules

1. **The panel's resolver, by tenant.** `GET /api/internal/guides` on
   tenant-service (`TENANT_INTERNAL_BASE_URL`, service token), with the
   integration's `tenantId` — never one a message names — and `surface=bot`.
   A reseller's own guide, its hide and the platform's fallback are therefore
   the panel's exactly, cache and ETag included. Unset, no menu has the row.
2. **Public, like a panel page.** A guest gets the row too: the install guide
   is often read before an account exists. Nothing here names a user.
3. **Screens.** `📖 Guides` lists the guides placed on `bot_screen:main_menu`
   under `📲 How to connect`; that asks for a system (`GUIDE_OSES`), then lists
   the guides placed on `os:<os>` — one per app, titled by the admin, so the bot
   keeps no app list. A tap opens the guide.
4. **Buttons name what they open** — `go:<os>`, `gk:<key>` (≤ 64 bytes for a
   60-character key) — so the flow keeps no state and an old screen still works.
5. **Text is flat and escaped.** `guidePlainText` takes Markdown's markers off,
   writes a list as `•`/`1.` lines, a callout with its tone's mark, a link as
   `label (url)` — only http(s); any other stays as written — and cuts at
   `GUIDE_TEXT_MAX` (3500) with `…`. The renderer escapes it like every message.
6. **Pictures and video follow the screen** (`FlowResult.media`, in block
   order: an image with its caption or alt, a step's image with its number, a
   video with its caption). Bytes come from `guide-media`'s in-network port
   (`GUIDE_MEDIA_INTERNAL_URL`, object-storage rule 10), never a Nest route,
   ≤ 50 MiB. Sent once per bot: the platform's `file_id` is kept at
   `bot:guidefile:…` (90 days) and sent instead next time. A file that cannot
   be had or sent is skipped; the text already said what it showed.

## Not here

Help placed on other bot screens: `bot_screen:support` is shown under support's
compose prompt (F-414-k, [contract.support.md](contract.support.md) rule 11);
the other screens' are not shown yet.
