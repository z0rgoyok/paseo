import type { AgentUsage } from "../../agent-sdk-types.js";

/** Actual native transcript UUID/stop_reason, never prompt text or inferred goal status. */
export function readClaudeGoalDelivery(content: string, deliveryId: string, completeFile: boolean) {
  let found = false,
    completed = false;
  let usage: AgentUsage | undefined;
  for (const line of content.split(/\r?\n/)) {
    const row = parseRow(line);
    if (!row) continue;
    if (row.isSidechain === true) continue;
    const message = objectValue(row.message);
    if (row.type === "user" && row.uuid === deliveryId) {
      found = true;
      completed = false;
      continue;
    }
    if (!found) continue;
    // Tool-result user records belong to this turn and do not introduce a new prompt.
    if (
      row.type === "user" &&
      Array.isArray(message?.content) &&
      message.content.some((item: unknown) => objectValue(item)?.type === "tool_result")
    )
      continue;
    if (row.type === "user") break;
    if (row.type !== "assistant" || !message) continue;
    if (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence") {
      completed = true;
      usage = readUsage(message.usage);
    }
  }
  let state: "completed" | "not_received" | "unknown" = "unknown";
  if (completed) state = "completed";
  else if (!found && completeFile) state = "not_received";
  return { state, usage };
}

function readUsage(input: unknown): AgentUsage | undefined {
  if (!input || typeof input !== "object") return undefined;
  const u = input as Record<string, unknown>;
  const tokens = (key: string) => {
    const value = u[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    inputTokens:
      tokens("input_tokens") +
      tokens("cache_read_input_tokens") +
      tokens("cache_creation_input_tokens"),
    outputTokens: tokens("output_tokens"),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
function parseRow(line: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(line));
  } catch {
    return undefined;
  }
}
