---
'@tenphi/luna': patch
---

`luna system-prompt-stats --session` and `--session-context --session` now read the session's `session.db`. They looked for per-session `inbound.db` and `outbound.db` files, which current installs no longer create, so both failed with "not found" or read a leftover file from an old install.
