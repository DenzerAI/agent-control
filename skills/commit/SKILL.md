---
name: commit
description: Git-Commit-Nachricht strukturieren
category: Entwicklungs-Workflow
triggers:
- 'Christian fragt nach: Git-Commit-Nachricht strukturieren'
inputs:
- User request
- Relevant local files, APIs or context named in the skill
outputs:
- Completed task, edited artifact or concrete recommendation according to the skill
permissions:
- Read relevant local files and context
- Edit or create files only when the user task or skill workflow requires it
- Call local tools or APIs named in the skill when needed
risks:
- Wrong trigger or stale context can produce bad work
- External sends, deploys, deletes or purchases need the explicit approvals defined by the skill and bootstrap rules
owner: klaus
status: active
---

# commit

Aenderungen zusammenfassen, Commit-Message schreiben.
