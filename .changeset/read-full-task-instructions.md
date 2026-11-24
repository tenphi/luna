---
'@tenphi/luna': patch
---

Luna can now read a scheduled task's full instructions (`list_tasks` with a `taskId`) before editing them, so changing a long task such as a daily digest no longer stalls on the shortened list preview or asks you to paste the instructions back.
