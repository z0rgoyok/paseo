import { expect, test } from "vitest";
import { readClaudeGoalDelivery } from "./goal-delivery-readback.js";
const id = "request-1";
const lines = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");
test("native user UUID and completed assistant prove result once", () => {
  const content = lines(
    { type: "user", uuid: id, message: { content: "task" } },
    { type: "assistant", message: { stop_reason: "tool_use" } },
    { type: "user", uuid: "tool-result", message: { content: [{ type: "tool_result" }] } },
    {
      type: "assistant",
      message: {
        stop_reason: "end_turn",
        usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 3 },
      },
    },
  );
  expect(readClaudeGoalDelivery(content, id, true)).toMatchObject({
    state: "completed",
    usage: { inputTokens: 15, outputTokens: 3 },
  });
});
test("prompt text, sidechain and incomplete assistant never fabricate completion", () => {
  expect(
    readClaudeGoalDelivery(
      lines({ type: "user", uuid: "other", message: { content: id } }),
      id,
      false,
    ).state,
  ).toBe("unknown");
  expect(
    readClaudeGoalDelivery(
      lines(
        { type: "user", uuid: id },
        { type: "assistant", isSidechain: true, message: { stop_reason: "end_turn" } },
      ),
      id,
      true,
    ).state,
  ).toBe("unknown");
  expect(
    readClaudeGoalDelivery(
      lines(
        { type: "user", uuid: id },
        { type: "assistant", message: { stop_reason: "tool_use" } },
      ),
      id,
      true,
    ).state,
  ).toBe("unknown");
});
test("only a complete transcript can prove non-receipt", () => {
  expect(readClaudeGoalDelivery("", id, true).state).toBe("not_received");
  expect(readClaudeGoalDelivery("", id, false).state).toBe("unknown");
});
