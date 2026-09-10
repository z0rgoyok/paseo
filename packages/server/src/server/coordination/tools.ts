import { createHash } from "node:crypto";
import { z } from "zod";
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { PaseoToolHostDependencies } from "../agent/tools/paseo-tools-builtin.js";
import type { PaseoToolCatalog, PaseoToolDefinition, PaseoToolResult } from "../agent/tools/types.js";
import { isPaseoToolEnabled } from "../agent/paseo-tool-policy.js";
import { teamRuntime } from "./runtime.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../agent/agent-prompt.js";
import { type Json, type ObjectValue, type Update, requireThat, CoordinationError, member, leader } from "./model.js";
import { withPermit } from "./context.js";
import { locateWorktree } from "./worktree.js";
import { startPanel, type TeamPanel } from "./panel.js";
import type { TeamStore } from "./store.js";

const jsonObject = z.record(z.string(), z.json());
const reference = z.object({ id: z.string(), version: z.number().int().positive(), relation: z.enum(["about", "reply_to", "relies_on", "watches"]) }).strict();
const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put"), id: z.string(), kind: z.enum(["task", "section", "resource", "result", "assignment"]), expectedVersion: z.number().int().nonnegative(), data: jsonObject, refs: z.array(reference).max(256).optional() }).strict(),
  z.object({ op: z.literal("post"), id: z.string(), text: z.string().min(1).max(64000), priority: z.enum(["normal", "important", "urgent"]).optional(), pinned: z.boolean().optional(), about: z.array(z.string()).optional(), replyTo: z.string().optional(), replaces: z.string().optional(), material: z.boolean().optional(), references: z.array(z.string()).optional() }).strict(),
  z.object({ op: z.literal("resolve"), id: z.string(), expectedVersion: z.number().int().positive(), explanation: z.string().min(10), observed: z.array(z.object({ id: z.string(), version: z.number().int().positive() }).strict()) }).strict(),
  z.object({ op: z.literal("ack"), id: z.string(), version: z.number().int().positive() }).strict(),
  z.object({ op: z.literal("ack_events"), through: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal("pause"), agentId: z.string(), paused: z.boolean() }).strict(),
  z.object({ op: z.literal("member"), agentId: z.string(), role: z.enum(["worker", "observer"]), paused: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("peers"), pairs: z.array(z.tuple([z.string(), z.string()])) }).strict(),
]);
const updateFields = { requestId: z.string().min(1), expectedRevision: z.number().int().positive().optional(), operations: z.array(operation).max(100) };
const scope = { workspaceId: z.string().optional() };
const guarded = new Set(["create_agent", "send_agent_prompt", "cancel_agent", "archive_agent", "kill_agent", "update_agent", "set_agent_mode", "create_heartbeat", "delete_heartbeat"]);
const commands = new Set(["create_agent", "send_agent_prompt", "cancel_agent", "archive_agent", "kill_agent", "update_agent", "set_agent_mode"]);
const panels = new WeakMap<TeamStore, TeamPanel>();
function result(value: unknown): PaseoToolResult { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }; }

export function withTeamTools(base: PaseoToolCatalog, options: PaseoToolHostDependencies): PaseoToolCatalog {
  const runtime = teamRuntime(options.agentManager);
  if (!runtime || options.voiceOnly) return base;
  const actor = options.callerAgentId ?? "human";
  const tools = new Map(base.tools);
  async function cwd(workspaceId?: string): Promise<string> {
    const callerCwd = options.callerAgentId ? await runtime!.agentCwd(options.callerAgentId) : null;
    const workspace = workspaceId ? await options.workspaceRegistry?.get(workspaceId) : null;
    if (workspaceId) requireThat(workspace, "WORKSPACE_NOT_FOUND", workspaceId);
    if (callerCwd && workspace) {
      const [a,b] = await Promise.all([locateWorktree(callerCwd), locateWorktree(workspace.cwd)]);
      requireThat(a && b && a.root === b.root, "CROSS_WORKTREE_SCOPE", workspaceId ?? "");
    }
    const path = workspace?.cwd ?? callerCwd; requireThat(path, "WORKSPACE_REQUIRED", "Top-level calls must provide workspaceId"); return path;
  }
  async function storeFor(workspaceId?: string): Promise<TeamStore> {
    const store = await runtime!.forCwd(await cwd(workspaceId)); requireThat(store, "TEAM_NOT_INITIALIZED", "Call team_init for this worktree first");
    member(store.load(), actor); return store;
  }
  function register(name: string, description: string, schema: z.ZodType, handler: (value: unknown) => Promise<unknown>): void {
    if (!isPaseoToolEnabled(options.paseoToolPolicy, name)) return;
    tools.set(name, { name, description, inputSchema: schema, handler: async input => {
      try { return result(await handler(await schema.parseAsync(input))); }
      catch (error) { return { ...result({ error: error instanceof CoordinationError ? error.code : "TEAM_OPERATION_FAILED", message: String(error) }), isError: true }; }
    } });
  }
  for (const [name, definition] of base.tools) {
    if (!guarded.has(name)) { tools.set(name, { ...definition, handler: (input, context) => base.executeTool(name, input, context) }); continue; }
    tools.set(name, { ...definition, handler: async (input, context) => {
      const target = input && typeof input === "object" && "agentId" in input ? String(input.agentId) : null;
      const current = options.callerAgentId ? await runtime.forAgent(options.callerAgentId) : null;
      const destination = target ? await runtime.forAgent(target) : null;
      if (!options.callerAgentId && name === "cancel_agent") return base.executeTool(name, input, context);
      requireThat(!current && !destination, "STATE_REQUIRED", "Use team_command. Worktree coordination, ACL and command persistence cannot be skipped by a raw tool call.");
      return base.executeTool(name, input, context);
    } });
  }
  const init = z.object({ ...scope, leaderId: z.string().optional(), stateSchema: jsonObject.optional() }).strict();
  register("team_init", "Enroll this Git worktree in durable coordination. Explicit opt-in; all workspace aliases sharing the physical worktree join the same board. Existing worktrees remain unchanged.", init, async input => {
    const args = init.parse(input); const lead = args.leaderId ?? options.callerAgentId;
    requireThat(lead, "LEADER_REQUIRED", "Choose an existing lead agent");
    requireThat(actor === "human" || lead === actor, "LEAD_REQUIRED", "An agent may only initialize itself as lead");
    const path = await cwd(args.workspaceId); const leadCwd = await runtime.agentCwd(lead);
    const [location, leadLocation] = await Promise.all([locateWorktree(path), leadCwd ? locateWorktree(leadCwd) : null]);
    requireThat(location && leadLocation?.root === location.root, "INVALID_LEAD_WORKTREE", lead);
    const store = await runtime.forCwd(path, true); requireThat(store, "GIT_WORKTREE_REQUIRED", path);
    store.initialize(location.root, lead, args.stateSchema as ObjectValue | undefined);
    await runtime.syncMembers(store); const exportPath = await runtime.exportState(store);
    return { ...store.snapshot(actor), exportPath };
  });
  const read = z.object({ ...scope, view: z.enum(["state", "board", "history", "events", "entity", "commands", "deliveries"]).default("board"), id: z.string().optional(), topic: z.string().optional(), query: z.string().optional(), after: z.number().int().nonnegative().optional(), before: z.number().int().nonnegative().optional(), revision: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional(), includeHistory: z.boolean().optional() }).strict();
  register("team_read", "Read original shared messages (urgent/pinned first), a thread/entity, topic, free-form plan, reconsideration obligations, command outcomes or durable history after a cursor. No generated memory summaries.", read, async input => {
    const args = read.parse(input); const store = await storeFor(args.workspaceId);
    switch (args.view) {
      case "state": return store.snapshot(actor);
      case "board": return store.board(actor, args);
      case "events": return store.history(actor, args.after ?? store.inboxCursor(actor), args.limit);
      case "history": return store.history(actor, args.after, args.limit);
      case "deliveries": return store.deliveries(actor);
      case "commands": return store.commands().filter(c => actor === "human" || actor === store.load().leader || c.actor === actor);
      case "entity": { requireThat(args.id && store.load().entities[args.id], "NOT_FOUND", args.id ?? "id required"); return store.load().entities[args.id]; }
    }
  });
  const update = z.object({ ...scope, ...updateFields }).strict();
  register("team_update", "Atomically update individual plan/focus/intention entities, post original board messages, attach result references, acknowledge exact urgent versions, or reconsider stale decisions. expectedVersion=0 creates; existing entities require their version. Only lead edits plans/policy. Urgent text is broadcast without waking idle workers.", update, async input => {
    const args = update.parse(input); const store = await storeFor(args.workspaceId);
    if (args.operations.some(op => op.op === "post" && (op.priority === "urgent" || op.replaces))) await runtime.syncMembers(store);
    for (const op of args.operations) if (op.op === "member") {
      const location = await locateWorktree(await runtime.agentCwd(op.agentId) ?? "");
      requireThat(location?.root === store.load().root, "CROSS_WORKTREE_MEMBER", op.agentId);
    }
    const receipt = store.update(actor, args as Update); const exportPath = await runtime.exportState(store);
    return { ...receipt, exportPath };
  });
  const command = z.object({ ...scope, ...updateFields, action: z.string(), args: jsonObject, taskId: z.string().optional(), interrupt: z.boolean().default(false) }).strict();
  register("team_command", "Persist a schema-validated checkpoint and command intent, then invoke an existing Paseo agent control tool. No blind retry of uncertain sends/creates. Uses current lead/peer authority and checks stale dependencies before new work.", command, async input => {
    const args = command.parse(input); requireThat(commands.has(args.action) && base.getTool(args.action), "COMMAND_NOT_ALLOWED", args.action);
    const store = await storeFor(args.workspaceId); await runtime.syncMembers(store);
    const target = typeof args.args.agentId === "string" ? args.args.agentId : null;
    if (target) { const path = await runtime.agentCwd(target); const location = path ? await locateWorktree(path) : null; requireThat(location?.root === store.load().root, "CROSS_WORKTREE_TARGET", target); }
    const nativeArgs = { ...args.args } as ObjectValue;
    if (args.action === "create_agent") {
      const workspaceId = typeof nativeArgs.workspaceId === "string" ? nativeArgs.workspaceId : args.workspaceId ?? options.agentManager.getAgent(options.callerAgentId ?? "")?.workspaceId;
      requireThat(workspaceId, "WORKSPACE_REQUIRED", "Managed creation must name an existing workspace in this worktree");
      await cwd(workspaceId); nativeArgs.workspaceId = workspaceId;
      if (options.callerAgentId) delete nativeArgs.background; else nativeArgs.background = true;
      nativeArgs.notifyOnFinish = false;
      const labels = nativeArgs.labels ?? {};
      requireThat(labels && typeof labels === "object" && !Array.isArray(labels), "INVALID_LABELS", "Agent labels must be an object");
      nativeArgs.labels = { ...labels, "cogerentor.command-id": createHash("sha256").update(JSON.stringify([actor, args.requestId])).digest("hex") };
    }
    if (args.action === "send_agent_prompt") { nativeArgs.background = true; nativeArgs.notifyOnFinish = false; }
    const assigned = Object.values(store.load().entities).find(e => e.kind === "assignment" && e.data.agentId === target && e.data.status === "active");
    const taskId = args.taskId ?? (typeof assigned?.data.taskId === "string" ? assigned.data.taskId : null);
    if (args.action === "create_agent") requireThat(taskId, "TASK_REQUIRED", "New workers need an existing taskId");
    if (args.interrupt) leader(store.load(), actor);
    const operations = [...args.operations];
    if (args.action === "cancel_agent" && target) operations.push({ op: "pause", agentId: target, paused: true });
    const sendInput = args.action === "send_agent_prompt" ? z.object({ agentId: z.string(), prompt: z.string(), sessionMode: z.string().optional(), background: z.boolean().optional(), notifyOnFinish: z.boolean().optional() }).strict().parse(nativeArgs) : null;
    const receipt = store.prepare(actor, { ...args, operations } as Update, args.action, nativeArgs, target, taskId);
    const saved = receipt.command!;
    if (saved.status !== "prepared") return { ...receipt, command: store.command(saved.id) };
    const intent = store.claim(saved.id); const team = store.load();
    try {
      const response = await withPermit({ root: team.root, epoch: team.epoch, actor, target, commandId: intent.id, kind: "command", noInterrupt: !args.interrupt && args.action === "send_agent_prompt" }, async () => {
        if (!sendInput) return base.executeTool(args.action, nativeArgs);
        await sendPromptToAgent({ agentManager: options.agentManager, agentStorage: options.agentStorage, agentId: sendInput.agentId,
          prompt: sendInput.prompt, sessionMode: sendInput.sessionMode, activeTurnBehavior: args.interrupt ? undefined : "steer", logger: options.logger });
        await waitForAgentRunStartWithTimeout(options.agentManager, sendInput.agentId);
        return result({ success: true, status: options.agentManager.getAgent(sendInput.agentId)?.lifecycle ?? "unknown" });
      });
      const serialized = JSON.parse(JSON.stringify(response)) as Json;
      store.finish(intent.id, response.isError ? "unknown" : "completed", serialized, response.isError ? "Native tool reported an error; inspect the agent before reconciling" : null);
    } catch (error) { store.finish(intent.id, "unknown", null, String(error)); }
    const exportPath = await runtime.exportState(store);
    return { command: store.command(intent.id), revision: store.load().revision, exportPath };
  });
  const reconcile = z.object({ ...scope, commandId: z.string(), outcome: z.enum(["completed", "failed"]), evidence: z.string().min(10) }).strict();
  register("team_reconcile", "Resolve an uncertain command only after observing the actual agent/provider state. Never use this to blindly resend a potentially executed command.", reconcile, async input => {
    const args = reconcile.parse(input); const store = await storeFor(args.workspaceId); store.reconcile(actor, args.commandId, args.outcome, args.evidence); return store.command(args.commandId);
  });
  const handoff = z.object({ ...scope, requestId: z.string(), leaderId: z.string(), expectedEpoch: z.number().int().positive() }).strict();
  register("team_handoff", "Transfer lead authority to an existing fresh agent in the same worktree. Persist intent, detach successor, move direct native children, then switch the epoch and durable team inbox. Existing native cron schedules are not migrated.", handoff, async input => {
    const args = handoff.parse(input); const store = await storeFor(args.workspaceId); const team = store.load();
    if (team.leader === args.leaderId && team.epoch === args.expectedEpoch + 1) return store.snapshot(actor);
    leader(team, actor); requireThat(team.epoch === args.expectedEpoch, "EPOCH_CONFLICT", String(team.epoch));
    requireThat(team.members[args.leaderId] && !team.members[args.leaderId].paused && args.leaderId !== team.leader, "INVALID_SUCCESSOR", args.leaderId);
    const successor = await runtime.agentCwd(args.leaderId); const location = successor ? await locateWorktree(successor) : null;
    requireThat(location?.root === team.root, "CROSS_WORKTREE_TARGET", args.leaderId);
    const receipt = store.prepare(actor, { requestId: args.requestId, operations: [] }, "lead_handoff", { leaderId: args.leaderId, oldLeader: team.leader, epoch: team.epoch }, null, null);
    const intent = receipt.command!;
    if (intent.status === "prepared") {
      store.claim(intent.id);
      try {
        await withPermit({ root: team.root, epoch: team.epoch, actor, target: null, commandId: intent.id, kind: "command", noInterrupt: true }, async () => {
          await options.agentManager.detachAgent(args.leaderId);
          for (const record of await options.agentStorage.list()) {
            if (record.id === args.leaderId || !team.members[record.id] || getParentAgentIdFromLabels(record.labels) !== team.leader) continue;
            const labels = { ...record.labels, [PARENT_AGENT_ID_LABEL]: args.leaderId };
            if (options.agentManager.getAgent(record.id)) await options.agentManager.setLabels(record.id, labels);
            else await options.agentStorage.upsert({ ...record, labels });
          }
        });
        store.finish(intent.id, "completed", { parentageTransferred: true });
      } catch (error) { store.finish(intent.id, "unknown", null, String(error)); }
    }
    requireThat(store.command(intent.id).status === "completed", "HANDOFF_UNCERTAIN", "Reconcile the native parentage operation before switching lead authority");
    store.update(actor, { requestId: `handoff-commit:${args.requestId}`, operations: [{ op: "handoff", leader: args.leaderId, expectedEpoch: args.expectedEpoch }] });
    await runtime.exportState(store); return store.snapshot(actor);
  });
  const heartbeat = z.object({ ...scope, seconds: z.number().int().min(30).max(86400).nullable() }).strict();
  register("team_heartbeat", "Configure one durable worktree heartbeat directed to the current lead, including after handoff. Null disables it; no native schedule duplication.", heartbeat, async input => {
    const args = heartbeat.parse(input); const store = await storeFor(args.workspaceId); store.setHeartbeat(actor, args.seconds); return store.snapshot(actor);
  });
  const panel = z.object(scope).strict();
  register("team_panel", "Open a read-only loopback dashboard with current plan, original board, history and delivery receipts. Host caller only; token never enters agent prompts.", panel, async input => {
    requireThat(actor === "human", "HOST_ONLY", "Open the panel from a top-level authenticated MCP client");
    const args = panel.parse(input); const store = await storeFor(args.workspaceId); let page = panels.get(store);
    if (!page) { page = await startPanel(store); panels.set(store, page); }
    return { url: page.url };
  });
  return { tools, getTool: name => tools.get(name), executeTool: async (name, input, context) => {
    const tool: PaseoToolDefinition | undefined = tools.get(name); requireThat(tool, "TOOL_NOT_FOUND", name);
    return tool.handler(input, context ?? {});
  } };
}
