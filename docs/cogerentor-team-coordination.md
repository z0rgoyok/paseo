# Cogerentor worktree coordination (experimental)

Opt-in team coordination for Paseo 0.8.0. This is a server extension in this fork,
not an installed third-party plugin or a change to the upstream daemon defaults.
Do not enable it on an ongoing production team before running the native checks
listed below. No enrollment, provider calls, schedules, or migration of personal
project material happens simply by checking out this branch.

## Model

The lead authors current plans, focus, next intentions, questions and acceptance
in small versioned entities. Workers publish original messages and result
references. There are no generated memory summaries. The board sorts active
urgent records, pinned records, important records, then recent messages; thread,
topic and text queries read the same records rather than copies.

An entity is stored once. `parent` builds the displayed task tree; `depends_on`
expresses prerequisites. A cancelled prerequisite is not a successful one.
A provider's idle status does not complete a task. Active assignments name an
active leaf task. Optional `exclusive_resources` prevent two active assignments
from declaring the same resource; they do not intercept filesystem writes.

Links have different meanings:

| Relation | Behaviour |
| --- | --- |
| `about` | Subject/filter membership; does not invalidate a decision. |
| `reply_to` | Conversation structure; does not imply agreement. |
| `relies_on` | A versioned basis; changes invalidate transitive consumers. |
| `watches` | A subject whose material changes require reconsideration. |

Normal conversation does not continuously invalidate plans. A material or urgent
post advances its subject records. Replacements inherit their original topics;
untagged posts have a worktree topic. Material publications also advance
`topic:worktree`, which can be watched for newly appearing constraints.
`replaces` preserves the old text, marks it superseded, and invalidates dependent
records. A decision is never rewritten by an automatic summarizer.

Invalidated decisions keep their original text with `stale` reasons. Updating a
timestamp or rewriting the text does not acknowledge those reasons. `resolve`
requires the current entity version, observed source versions and an explanation.
This verifies recorded processing, not the truth of an agent's reasoning.

## Storage and identity

Requires Git and Node **22.13 or later** with `node:sqlite`. It adds no npm runtime
dependency; Ajv and Zod are already server dependencies. Ordinary worktrees do
not use SQLite until enrolled.

The canonical Git worktree is obtained from real paths and its actual Git admin
directory. Different Paseo workspaces or nested directories on that worktree
share the board. A sibling Git worktree has another board, even on the same
repository or branch. Provider-native read-only subagents without their own
Paseo agent session are not independently addressable recipients.

Data lives outside tracked source:

```text
<git-common-dir>/cogerentor/worktrees/<sha256(real-git-dir)>/
  team.sqlite
  team.sqlite-wal
  team.sqlite-shm
  team-state.json
```

SQLite is authoritative. Metadata and current entities have separate rows;
unchanged messages are not rewritten for every plan update. History, nonces,
commands, inbox cursors and delivery receipts are separate tables. WAL with
`synchronous=FULL` is used. The JSON file is an atomic, disposable projection for
compatibility, not a second editable source of truth. The panel reads a single
SQLite transaction instead of combining different JSON generations.

The implementation is single-daemon/single-host per worktree. A PID/token lease
prevents another live daemon from dispatching the same outbox. A newly owning
daemon marks interrupted commands unknown and previous runtime observations
unknown; persisted `running` is not presented as a live observation after restart.
An active lease is never stolen on a timeout. Renaming/moving a worktree with a
changed canonical root requires an explicit migration, not silent identity reuse.

## Tools

Tools are exposed through the shared catalog, for both MCP and native providers,
subject to the existing exact-provider tool policy. Actor identity comes from
the caller-scoped catalog; an agent cannot supply a `human` actor field.
Top-level calls provide a Paseo `workspaceId`; agent-scoped calls infer the scope.

| Tool | Purpose |
| --- | --- |
| `team_init` | Explicitly enroll a worktree and select an existing lead. |
| `team_read` | State, original board, entity, event cursor, history, commands or receipts. |
| `team_update` | Partial entity updates, posts, acknowledgements and reconsideration. |
| `team_command` | Persist a checkpoint and intent, then create/send/cancel/archive/kill/update an agent or change its mode. |
| `team_reconcile` | Resolve uncertain commands with evidence, or abandon a prepared command as failed. |
| `team_handoff` | Detach a successor, transfer direct native children and switch lead epoch. |
| `team_heartbeat` | Configure one durable team heartbeat, off by default; `null` disables it. |
| `team_panel` | Host-only read-only loopback dashboard with a bearer token. |

Other native terminal, workspace, permission and schedule capabilities retain
Paseo's own policies. This is an agent-coordination gate, not a complete platform
sandbox. Native team heartbeats should be disabled before enabling the new one;
existing native cron schedules are not automatically migrated.

### Enroll

From the lead's existing conversation, after the user authorizes enrollment:

```json
{"tool":"team_init","arguments":{}}
```

A host caller supplies `workspaceId` and `leaderId`. Optional `stateSchema` is a
synchronous Ajv-compatible JSON Schema for the projected plan/sections/assignments.
Schema validation runs in the same transaction as a checkpoint and its command.
The schema must admit the empty initial plan. Runtime facts are observed separately
and can make decisions stale; a failing schema never suppresses the factual event.

### Current plan and free-form focus

One task is one entity. Do not put an entire duplicate tree in a section.
`expectedVersion: 0` creates a record; existing records require their version.
`expectedRevision` is optional for independent writes and required by the caller
when its decision assumes a particular whole-team revision.

```json
{
  "requestId":"plan-001",
  "operations":[
    {"op":"put","id":"search","kind":"task","expectedVersion":0,
     "data":{"name":"Implement search","status":"active","depends_on":[],"next_action":"Implement, test and submit for review"}},
    {"op":"put","id":"team_focus","kind":"section","expectedVersion":0,
     "data":{"text":"Finish the search behaviour before returning to delivery"},
     "refs":[{"id":"search","version":1,"relation":"relies_on"}]}
  ]
}
```

There is no prose rewriting requirement on every message. A valid empty operation
list can record a command intent without pretending the team's focus changed.

### Original messages, corrections and urgent delivery

```json
{
  "requestId":"notice-001",
  "operations":[
    {"op":"post","id":"runtime-warning","priority":"urgent",
     "about":["topic:runtime"],
     "text":"The shared test environment is on an older API revision. Do not apply its test results to the current implementation."}
  ]
}
```

Urgent records are bounded to 4,000 characters and ordinary messages to 64,000.
Use references for large logs. Publish a new message with `replaces` to correct or
close a warning. Original text and earlier versions stay in history. Closing an
urgent warning also broadcasts, even when the new message has normal priority.

All known non-internal Paseo participants on the physical worktree are recipients,
not just agents with the same parent. Working agents are steered without silent
interrupt-and-replace fallback. Idle workers stay asleep; active warnings are
included on their next foreground start. The lead can be awakened for durable
events. An unloaded/unavailable lead's inbox stays queued until its session is
resumed. There is no promise of immediate cognition or retroactive cancellation
of a tool already running.

Delivery is at least once, with IDs/versions and exact-version acknowledgements:

```json
{"requestId":"ack-001","operations":[{"op":"ack","id":"runtime-warning","version":1}]}
```

Delivered means the provider accepted the input path, not that the model understood
it. Acknowledged means the agent explicitly acknowledged that version. Still-active
warnings remain visible after acknowledgement. New foreground context includes
active warnings and a budgeted selection of original recent messages. Intra-turn
provider compaction is not a universal interception point in this implementation.
Use the next foreground start or explicitly read the board after compaction.

### Durable events and reconsideration

`team_read` with `view: "events"` defaults to the saved processing cursor. Pass
`after` for an explicit cursor. Advance it together with the decision updates:

```json
{"requestId":"processed-001","operations":[{"op":"ack_events","through":123}]}
```

The logical lead cursor follows handoff. Reading does not implicitly acknowledge.
`view: "history"` starts at an explicit historical cursor and includes full stored
changes. Use bounded pages; do not load the entire archive into every prompt.

To reconsider a stale decision, first inspect its reasons and current source
versions, then send `resolve` with those versions and an explanation. A result
reference uses `kind: "result"` and `data: {taskId, artifact, sha256, ...}`. The
reference's format is checked; the lead/reviewer must verify the actual artifact
and its applicability. Merely submitting a result never marks a task done.

### Agent control

Discover an available profile/model through the existing Paseo tools, then:

```json
{
  "requestId":"start-search-001",
  "taskId":"search",
  "operations":[],
  "action":"create_agent",
  "args":{"title":"Search implementation","provider":"<configured-provider/model>",
          "initialPrompt":"Implement the assigned search task and post the result reference."}
}
```

The lead controls membership and agent lifecycle. Workers may send prompts only
to the lead or explicitly allowed peers. `peers` sets symmetric allowed pairs.
For a managed creation, an existing workspace in the same worktree and an active
leaf task are required. The new agent is recorded with an assignment and a command
identity label so an uncertain creation can be investigated.

`send_agent_prompt` through `team_command` prefers steering without interruption.
`interrupt: true` is an explicit lead/host option. Commands do not silently gain
that permission from an urgent message. Raw agent lifecycle tools are rejected
for enrolled participants; the underlying shared command gate also checks the
persisted permit, current lead epoch and task freshness.

Host conversations remain usable: the shared prompt entry point journals incoming
host requests rather than requiring the user to edit a JSON checkpoint before
speaking to the lead. A paused lead may be resumed by the host, not by itself.
Host stop remains available if storage fails; that exceptional stop is logged
and automatic coordination is stopped in that process. An ordinary cancel records
a paused participant and leaves task completion explicit. It does not extract an
unfinished model context or fabricate a final result.

### Handoff

Create the successor with an explicit task first, then call `team_handoff` with its
ID and the current `expectedEpoch`. The native parentage phase is journaled. Direct
children belonging to this worktree are moved, the successor is detached from
its predecessor, and the team epoch changes only after success. The old lead loses
control authority and is paused. Native cron schedules outside the new team
heartbeat are not transferred. An uncertain native phase needs reconciliation;
neither parentage changes nor provider calls are assumed to be one SQLite transaction.

## Panel

`team_panel` is available to an authenticated top-level caller, not injected into
agent prompts with its bearer token. It provides a local read-only page with
current plan, raw board, history and delivery status. The token is in the URL
fragment; API requests require it in the Authorization header. No CORS, strict
Host checking, CSP and text-only rendering prevent a board message from becoming
HTML. On a remote daemon, explicitly forward the loopback port. This first version
is a separate browser panel, not a new native mobile workspace tab.

## Guarantees and boundaries

- A checkpoint, graph invalidations, command intent and delivery work are committed
  together, or rolled back together. Only touched entities are persisted anew.
- Registered dependencies are traversed transitively. Their consumers are updated
  mechanically or marked for reconsideration. Hidden semantic relationships in
  arbitrary text cannot be guaranteed; declare a basis or watch a topic.
- A repeated request ID with the same input returns its recorded result. Different
  input with the same ID is rejected. Interrupted external commands become unknown
  and are never replayed blindly. An unattempted prepared command may be abandoned.
- Acknowledged messages and processed event cursors are durable, but do not prove
  that an agent's conclusion is correct. Delivery cannot stop an already-executing
  external shell command or guarantee a provider supports noninterrupting steering.
- Shell access, daemon credentials, trusted plugins, filesystem writes and external
  API operations remain outside this coordination ACL. No OS sandbox is claimed.
- The current graph is evaluated in memory. History and board pages are bounded at
  the API, but this is not a distributed or million-node graph engine.

## Validation

Run the standalone persistence/graph/outbox/panel/worktree checks:

```bash
node scripts/test-team-coordination.mjs
```

This requires an installed TypeScript compiler and Node typings. It compiles the
standalone modules under strict TypeScript and runs actual SQLite/filesystem/HTTP
checks. `PASEO_TEAM_TYPE_ROOTS` may point to local Node declaration directories
when using a global compiler. It does **not** replace the monorepo typecheck,
provider contract tests or full Paseo build.

Before enabling the extension on a live team, also run the existing server
`typecheck` and targeted agent-manager/agent-prompt/MCP lifecycle tests, the normal
repository formatter/linter, and a provider smoke test for create, send, urgent,
stop, restart and handoff. These native integration/build checks were unavailable
in the isolated implementation environment; the integration is an experimental
review candidate, not a production validation claim.

Inherited GitHub Actions remain disabled according to this fork's policy. No CI,
release, deployment or application installation is enabled by this feature.
