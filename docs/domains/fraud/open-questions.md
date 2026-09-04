---
id: fraud
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — fraud

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `subjectId` is a polymorphic UUID with no FK. How is referential integrity kept when a subject is deleted? | no | ASSUMED(2026-09-04): soft-delete everywhere; flags outlive subjects | -> data-model.md |
| 2026-09-04 | Which detections run, how often, and their thresholds (`multi_account_same_device`, `config_ip_sharing`, `torrent_traffic_detected`, ...)? | no | ASSUMED(2026-09-04): an `automation` `fraud_scanner` worker, thresholds in config | -> automation + rules.md |
| 2026-09-04 | Fingerprint hashing recipe (UA + canvas + IP subnet) — computed client-side, server-side, or both? | no | ASSUMED(2026-09-04): server-side from request + a client-provided canvas token | -> security/threat-model.md |
