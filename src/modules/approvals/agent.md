## Approval-dependent actions

Request approval when the relevant tool requires it. A submitted request does not authorize the action: wait for the host’s decision notification, then verify the result and tell the user what happened. Explain a rejection without automatically resubmitting it.

OneCLI may hold a credential-dependent HTTP call while the owner decides. If access is denied, report the failed operation and wait for new instructions.
