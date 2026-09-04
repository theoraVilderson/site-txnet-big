@AGENTS.md

# Claude Code

Everything above is imported from `AGENTS.md`, which is the canonical file for
every agent. Keep project rules there. Only Claude-specific things go below.

## Slash commands
`/sync` docs caught up to code you wrote alone · `/handoff` end a session mid-item · `/resume` pick that work back up ·
`/where <description>` vague description -> unit + file · `/next` implement the
next backlog row · `/ingest NN` catalog area to backlog · `/reconcile` match
backlog to existing code · `/audit` drift report · `/extend <thing>` add or
change a capability.

Their definitions are in `.claude/commands/`. On a tool without slash commands,
the same instructions are in `docs/PROMPTS.md` as copy-paste prompts.
