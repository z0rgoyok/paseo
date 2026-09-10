/** The provider runtime remains unchanged; coordination gates surround public admission. */
import { AgentManager as AgentRuntime, type AgentManagerOptions } from "./agent-manager-runtime.js";
import { bindTeamRuntime, teamRuntime } from "../coordination/runtime.js";
import { assertInterruptAllowed } from "../coordination/context.js";
export * from "./agent-manager-runtime.js";

export class AgentManager extends AgentRuntime {
  constructor(options: AgentManagerOptions) {
    super({ ...options, beforeSteerUnavailableFallback: async input => {
      assertInterruptAllowed();
      await options.beforeSteerUnavailableFallback?.(input);
    } });
    bindTeamRuntime(this, options);
  }
  override async createAgent(...args: Parameters<AgentRuntime["createAgent"]>): ReturnType<AgentRuntime["createAgent"]> {
    const runtime = teamRuntime(this);
    if (!args[0].internal) await runtime?.guardCwd(args[0].cwd, null);
    const agent = await super.createAgent(...args);
    if (!agent.internal) await runtime?.created(agent);
    return agent;
  }
  override streamAgent(...args: Parameters<AgentRuntime["streamAgent"]>): ReturnType<AgentRuntime["streamAgent"]> {
    const runtime = teamRuntime(this);
    if (runtime) args[1] = runtime.injectSync(args[0], args[1]);
    return super.streamAgent(...args);
  }
  override async replaceAgentRun(...args: Parameters<AgentRuntime["replaceAgentRun"]>): ReturnType<AgentRuntime["replaceAgentRun"]> {
    await teamRuntime(this)?.guardAgent(args[0]);
    return super.replaceAgentRun(...args);
  }
  override async steerOrReplaceActiveTurn(...args: Parameters<AgentRuntime["steerOrReplaceActiveTurn"]>): ReturnType<AgentRuntime["steerOrReplaceActiveTurn"]> {
    await teamRuntime(this)?.guardAgent(args[0]);
    return super.steerOrReplaceActiveTurn(...args);
  }
  override tryRunOutOfBand(...args: Parameters<AgentRuntime["tryRunOutOfBand"]>): ReturnType<AgentRuntime["tryRunOutOfBand"]> {
    const agent = this.getAgent(args[0]);
    if (agent && !agent.internal) teamRuntime(this)?.guardCwdSync(agent.cwd, agent.id);
    return super.tryRunOutOfBand(...args);
  }
  override prepareForShutdown(): void {
    teamRuntime(this)?.stop();
    super.prepareForShutdown();
  }
}
