---
id: guide
layer: domain
status: draft
updated: 2026-10-04
---

# Invariants — guide

Planned (F-414-a); each row names what will enforce it.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A tenant reads the platform's guides and its own, writes only its own | RLS shared-read policy | a reseller edits the platform's help, or reads another's |
| 2 | One guide per key per owner | partial unique indexes | two answers for one placement |
| 3 | A tenant's guide with a platform key replaces it for that tenant only; a hide removes it for that tenant only | the resolver (F-414-b), one query | one reseller's change shows for every reseller |
| 4 | A guide's text is shown only in a language it has, else the fallback order | the resolver | a blank help page |
