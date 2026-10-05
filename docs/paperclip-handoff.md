# Initial assignment from Paperclip

The `/mcp/handoff` ingress exposes only `paseo_assign`. Paperclip sends the first
assignment and receives a durable acceptance receipt. Paseo owns executor
initialization, goals, task state, team coordination and review after acceptance.
The receipt does not claim that a provider has started or that work is complete.

## Configuration

Set `PASEO_HANDOFF_TOKEN` from a registered secret replica in process memory.
It is a separate credential for this endpoint. Do not use the daemon admin
password. Store the token in the Paperclip connection vault and its encrypted
Deploy OS backup. HTTPS ingress must forward the request to the configured host.

Configure approved projects in `$PASEO_HOME/config.json`:

```json
{
  "daemon": {
    "handoff": {
      "issuer": "paperclip/company-id",
      "projects": {
        "project-key": {
          "cwd": "/approved/project/root",
          "provider": "codex",
          "model": "configured-model",
          "thinkingOptionId": "high"
        }
      }
    }
  }
}
```

The client cannot choose a command, filesystem root or model. The operator's
binding selects those values. Codex starts in full-access mode; Claude starts
with bypassPermissions. Their existing OS permissions remain the boundary.
Every executable assignment has a real active goal readback first. Codex uses
the native goal API; Claude uses the persistent manager goal. Unsupported
provider capabilities refuse execution. Configure direct Tracker bootstrap on
the receiver when the assigned process needs Tracker.

## Contract and retries

Input contains `task_ref`, `project`, `objective`, `brief` and optional existing
`take_comment`. The task URL and credential's issuer form the durable identity.
Query strings and fragments do not produce new assignments. A repeated request
with the same brief returns the same handoff/executor IDs. A changed brief is
rejected. Only approved project bindings can be assigned.

Acceptance is synced to disk before returning. A single local initialization
worker drives the queued assignment through workspace creation, executor
registration, real goal registration/readback and prompt dispatch. These steps
use normal Paseo workspace and agent services. It creates no Tracker objects.

Records live under `$PASEO_HOME/handoffs`. Queued records replay after restart.
Interrupted initialization and uncertain provider starts are held for native
session reconciliation. They keep the original executor identity and are never
blindly launched again. The operator reads `/api/handoffs/<handoff_id>` through
normal daemon authorization to inspect admission phase and a redacted error.
This is the assignment receipt/admission state, not a Paperclip task lifecycle.

The receiver never calls Paperclip to update task status and exposes no tools
for monitoring, continued prompts, model changes, archive or cancellation.
Revoking the connection blocks new assignments; it does not cancel work already
accepted by Paseo. Stop/pause accepted work through the existing Paseo owner
controls. Production activation needs a managed release, backup, rollback and
an actual remote MCP assignment smoke.
