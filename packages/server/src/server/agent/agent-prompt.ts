import * as prompt from "./agent-prompt-runtime.js";
import { teamRuntime } from "../coordination/runtime.js";
import { dispatchContext } from "../coordination/context.js";
export * from "./agent-prompt-runtime.js";

/** Raw agent tools are fenced by the caller-scoped catalog; host conversations remain usable. */
export async function sendPromptToAgent(...args: Parameters<typeof prompt.sendPromptToAgent>): ReturnType<typeof prompt.sendPromptToAgent> {
  const input = args[0]; const runtime = teamRuntime(input.agentManager);
  const permit = dispatchContext.getStore();
  if (!runtime || (permit && !permit.closed)) return prompt.sendPromptToAgent(...args);
  const isUser = input.unarchive !== false && !(typeof input.prompt === "string" && prompt.isSystemInjectedEnvelope(input.prompt));
  return runtime.hostPrompt(input.agentId, input.prompt, isUser, () => prompt.sendPromptToAgent(...args));
}
