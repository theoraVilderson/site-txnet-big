---
id: agent-setup
status: active
updated: YYYY-MM-DD
---

# Running this with any model or tool

Nothing here is Claude-specific. The skeleton is plain Markdown plus four
dependency-free Python scripts. What differs between tools is only **how the
rules get loaded** and **whether the agent can run a shell**.

That second one is the real split, and it decides everything else:

| | agent reads files + runs a shell | agent sees only what you paste |
|---|---|---|
| examples | Claude Code, Cursor, Codex CLI, Cline, Aider, Zed, Copilot agent, OpenCode | a chat window, a raw OpenRouter/API call |
| who runs `spec.py` / `where.py` | the agent | **you**, and you paste the output |
| do you re-attach files each session | **no** | one paste at the start, then no |
| setup | one file, once | `python3 tools/context.py` |

---

## Case A — the agent can read files and run a shell

`AGENTS.md` at the repo root is the canonical rules file. It is read natively by
Codex, Cursor, Copilot, Gemini CLI, Aider, Zed, Jules, Windsurf and others.
Claude Code reads `CLAUDE.md`, so the `CLAUDE.md` shipped here is one line —
`@AGENTS.md` — plus the Claude-only slash-command list.

**Never duplicate `AGENTS.md` into a second file.** Two near-identical rule files
drift within a month, and then no one knows which one the agent actually
followed. Point at it instead:

| tool | file it reads | what to put there |
|---|---|---|
| Codex, Cursor, Copilot, Gemini CLI, Aider, Zed, Windsurf, Jules | `AGENTS.md` | nothing — it already works |
| Claude Code | `CLAUDE.md` | `@AGENTS.md` (already shipped) |
| Cline | `.clinerules` | `See AGENTS.md in the repo root. Follow it.` |
| anything else | its own rules file | the same one-line pointer |

After that, **you attach nothing, ever**. The rules load at session start and the
agent runs the tools itself.

### Slash commands

`/next`, `/handoff`, `/where` and the rest live in `.claude/commands/`. Tools
with their own command format can read those `.md` files as-is — the bodies are
plain prompts. On a tool with no command support, the identical prompts are in
`docs/PROMPTS.md`; paste the one you want.

### One honest warning about weaker models

The protocol works by **obedience**. "Never open `App-Features.md`" is a rule,
not a lock. A strong model follows it; a cheap one will grep the repo the moment
it feels lost, pull four thousand lines of catalog into context, and produce
confident nonsense for the rest of the session.

If you are running a small or unfamiliar model, do not rely on the rule alone:

- Split the catalog by area — the tooling globs `docs/features/App-Features*.md`,
  so `App-Features-billing.md` and friends are already supported. A bad grep
  then costs you one area instead of the whole spec.
- Or keep the catalog outside the agent's working directory entirely and let
  `spec.py` reach it. If the file is not in the tree, it cannot be opened by
  accident.
- Watch the first few sessions. If you see a `grep -r` or a read of the catalog,
  that model needs the mechanical version above, not a stricter sentence.

Use the strongest model you can afford for BOOTSTRAP, the catalog, and the unit
map. Those decisions are expensive to reverse. `/next` on a well-formed backlog
row is a much smaller ask, and a cheaper model handles it fine.

---

## Case B — a chat window or a raw API call (OpenRouter, etc.)

Here the model has no filesystem, so it cannot run `spec.py` or `where.py`. You
run them. That is less painful than it sounds, because the whole design is
already built around handing the agent small, exact slices instead of letting it
browse.

### Start of session — paste once

```bash
python3 tools/context.py --lean                    # ~3k tokens
python3 tools/context.py                           # ~7k, full protocol text
python3 tools/context.py --item F-0201             # + that feature's spec block
python3 tools/context.py --find "profile button"   # + where.py resolution
python3 tools/context.py --unit billing            # + that unit's INDEX/contract
```

The bundle contains the protocol, `AGENTS.md`, `MASTER_INDEX.md`, `BACKLOG.md`,
the handoff if one is active, and the progress report. It also tells the model
it has no shell, so it should ask you to run a command rather than ask you to go
find a file.

**Paste it once**, at the top of the session. Not every message. If the model
starts asking for the catalog, paste the `spec.py` output for the one id it
needs — never the catalog.

Use `--lean` by default. The full protocol text is worth its extra 4k tokens
only for BOOTSTRAP, MIGRATION, or a session that will do contract surgery.

### During the session

When it needs something, it asks and you run one command:

| it asks for | you run |
|---|---|
| "where is the profile button?" | `python3 tools/where.py "profile button"` |
| "what does F-0207 require?" | `python3 tools/spec.py F-0207` |
| "what is left to build?" | `python3 tools/backlog.py` |
| the catalog | **nothing.** Ask which id, then `spec.py` that id |

### End of session

Ask for the complete text of `docs/HANDOFF.md` and any changed `BACKLOG.md`
rows, save them, and the next session starts with
`python3 tools/context.py` again. The context bundle picks the handoff up
automatically once its `status:` is `active`.

### The cost, honestly

Case B costs you a few copy-pastes per session. What it buys is that a
$0.30/Mtok model on OpenRouter operates on the same 40-line slice of spec that a
frontier model would, instead of on a summary of a summary. For a long-lived
project that trade is usually worth it — but if you are doing BOOTSTRAP or
writing the catalog, use Case A with a strong model. Those are the sessions
where being wrong is expensive.

---

## Mixing models

This works well and is the normal case:

| task | what it needs | reasonable choice |
|---|---|---|
| BOOTSTRAP, catalog authoring, unit map | judgement, boundary-finding, saying "this contradicts §2.2" | the strongest model you have |
| `/next` on a well-formed row | following a 40-line spec inside one unit | mid-tier is fine |
| `/reconcile`, `/audit` | careful, conservative reading | mid-tier, but check its work |
| mechanical edits, renames, test scaffolding | almost nothing | cheap and fast |

The reason mixing works at all is that the state lives in files, not in a
conversation. Any model can pick up `BACKLOG.md` + `HANDOFF.md` and continue —
including a different model from the one that started the item. That is the
whole point of writing the state down.
