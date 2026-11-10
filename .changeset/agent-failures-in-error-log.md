---
'@tenphi/luna': patch
---

Agent failures now reach `luna.error.log`, `luna status` and `luna health`: a model call that fails after its retries, an agent runner or tool server that cannot start, and an MCP server that cannot connect. Before, they were logged only at debug level, so a generic "Something went wrong" reply left no cause in the host logs. Model errors that a retry absorbs stay at debug level.
