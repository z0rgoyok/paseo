import * as lifecycle from "./lifecycle-command-runtime.js";
import { guardNativeAgent, teamRuntime } from "../coordination/runtime.js";
export * from "./lifecycle-command-runtime.js";
import { dispatchContext } from "../coordination/context.js";

export async function cancelAgentRunCommand(...args: Parameters<typeof lifecycle.cancelAgentRunCommand>): ReturnType<typeof lifecycle.cancelAgentRunCommand> {
  const runtime = teamRuntime(args[0].agentManager);
  if (runtime && !dispatchContext.getStore()) return runtime.hostCancel(args[1], () => lifecycle.cancelAgentRunCommand(...args));
  await guardNativeAgent(args[0].agentManager, args[1]);
  return lifecycle.cancelAgentRunCommand(...args);
}
export async function archiveAgentCommand(...args: Parameters<typeof lifecycle.archiveAgentCommand>): ReturnType<typeof lifecycle.archiveAgentCommand> {
  await guardNativeAgent(args[0].agentManager, args[1]);
  return lifecycle.archiveAgentCommand(...args);
}
export async function closeAgentCommand(...args: Parameters<typeof lifecycle.closeAgentCommand>): ReturnType<typeof lifecycle.closeAgentCommand> {
  await guardNativeAgent(args[0].agentManager, args[1]);
  return lifecycle.closeAgentCommand(...args);
}
export async function updateAgentCommand(...args: Parameters<typeof lifecycle.updateAgentCommand>): ReturnType<typeof lifecycle.updateAgentCommand> {
  await guardNativeAgent(args[0].agentManager, args[1].agentId);
  return lifecycle.updateAgentCommand(...args);
}
export async function setAgentModeCommand(...args: Parameters<typeof lifecycle.setAgentModeCommand>): ReturnType<typeof lifecycle.setAgentModeCommand> {
  await guardNativeAgent(args[0].agentManager, args[1].agentId);
  return lifecycle.setAgentModeCommand(...args);
}
export async function detachAgentCommand(...args: Parameters<typeof lifecycle.detachAgentCommand>): ReturnType<typeof lifecycle.detachAgentCommand> {
  await guardNativeAgent(args[0].agentManager, args[1]);
  return lifecycle.detachAgentCommand(...args);
}
