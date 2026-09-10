# Fork Actions policy

All inherited workflows are parked here intentionally. GitHub Actions does not discover this directory. There are no push, pull-request, schedule, release, deployment or workflow-run triggers in this fork's main branch.

Local checks remain enabled. Do not restore inherited workflows automatically when syncing upstream. To opt in later, audit one workflow and move only that definition back into `.github/workflows/`, preferably with `workflow_dispatch` only and bounded runtime/concurrency. Release and deployment credentials must never be reused from upstream.

This is a repository-content policy, not a change to account billing, Actions permissions, or already-running jobs. Existing branches retain their own workflow definitions.
