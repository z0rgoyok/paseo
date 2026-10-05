import path from "node:path";
import type { Express } from "express";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../agent/agent-prompt.js";
import { hashDaemonPassword } from "../auth.js";
import type { HandoffConfig } from "./contract.js";
import { HandoffService, type AssignmentExecution } from "./service.js";
import { mountHandoffMcp } from "./mcp.js";

export interface HandoffRuntime {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  ensureWorkspace(cwd: string): Promise<string>;
}

function fullAccessMode(provider: string): string | undefined {
  if (provider === "codex") return "full-access";
  if (provider === "claude") return "bypassPermissions";
  return undefined;
}

export function createAssignmentExecution(
  config: HandoffConfig,
  runtime: HandoffRuntime,
): AssignmentExecution {
  const { agentManager, agentStorage, logger, ensureWorkspace } = runtime;
  return {
    initialize: async (assignment, executorId) => {
      const project = config.projects[assignment.project];
      if (await agentStorage.get(executorId))
        throw new Error("Executor already persisted; reconcile initialization in Paseo");
      const workspaceId = await ensureWorkspace(project.cwd);
      await agentManager.createAgent(
        {
          provider: project.provider,
          cwd: project.cwd,
          model: project.model,
          thinkingOptionId: project.thinkingOptionId,
          systemPrompt: project.systemPrompt,
          title: assignment.objective.slice(0, 120),
          modeId: fullAccessMode(project.provider),
        },
        executorId,
        {
          workspaceId,
          labels: {
            role: "team-lead",
            "paseo.handoff": "initial-assignment",
            source: config.issuer,
            task_ref: assignment.task_ref,
            ...(assignment.take_comment ? { take_comment: assignment.take_comment } : {}),
          },
        },
      );
      await agentManager.setAgentGoal(executorId, assignment.objective);
      if ((await agentManager.getAgentGoal(executorId))?.status !== "active")
        throw new Error("Real active goal readback absent");
    },
    start: async (assignment, executorId, handoffId) => {
      if (agentManager.hasInFlightRun(executorId))
        throw new Error("Executor already running; automatic replacement refused");
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: executorId,
        prompt: `Initial assignment ${handoffId}\nTask: ${assignment.task_ref}\n${assignment.brief}`,
        messageId: handoffId,
        logger,
        unarchive: false,
      });
      await waitForAgentRunStartWithTimeout(agentManager, executorId);
    },
  };
}

export function createHandoffIngress(
  app: Express,
  config: { handoff?: HandoffConfig; handoffToken?: string; paseoHome: string },
  runtime: HandoffRuntime,
): HandoffService | null {
  if (!config.handoff) return null;
  if (!config.handoffToken)
    throw new Error("Configured assignment ingress requires PASEO_HANDOFF_TOKEN");
  const service = new HandoffService(
    path.join(config.paseoHome, "handoffs"),
    config.handoff,
    createAssignmentExecution(config.handoff, runtime),
  );
  mountHandoffMcp(app, service, hashDaemonPassword(config.handoffToken));
  app.get("/api/handoffs/:id", (req, res) => {
    void service
      .inspect(req.params.id)
      .then((record) => {
        if (!record) return res.status(404).json({ error: "Assignment not found" });
        return res.json(record);
      })
      .catch(() => {
        res.status(500).json({ error: "Assignment readback unavailable" });
      });
  });
  return service;
}
