---
'@tenphi/luna': patch
---

A full disk no longer crashes the Luna host. Before, a log write that failed with "no space left on device" became an uncaught exception, so launchd restarted the host in the middle of a reply, and any log output written afterwards was silently dropped. Log files now skip the lines they cannot store, keep writing once there is room again, and record how much output was lost.
