import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentReceipt } from "./agent-receipt.js";

export function trackerCommentReference(value: string): {
  taskKey: string;
  projectKey: string;
  sequenceNumber: number;
  commentId: number;
} {
  const url = new URL(value);
  if (url.origin !== "https://tracker.tich.app") throw new Error("Tracker receipt origin mismatch");
  const task = /^\/project\/([A-Za-z0-9_]+)\/issue\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  const comment = /^#comment-([1-9][0-9]*)$/.exec(url.hash);
  if (!task || !comment) throw new Error("Canonical Tracker task/comment link required");
  const sequenceNumber = Number(task[2]),
    commentId = Number(comment[1]);
  if (!Number.isSafeInteger(sequenceNumber) || !Number.isSafeInteger(commentId))
    throw new Error("Invalid Tracker reference");
  return {
    taskKey: task[1] + "-" + sequenceNumber,
    projectKey: task[1],
    sequenceNumber,
    commentId,
  };
}
function dataOf(input: unknown): unknown {
  if (!input || typeof input !== "object") throw new Error("Tracker readback invalid");
  const result = input as Record<string, unknown>;
  if (result.isError) throw new Error("Tracker readback rejected");
  let data = result.structuredContent;
  if (data === undefined && Array.isArray(result.content)) {
    for (const block of result.content)
      if (block.type === "text") {
        try {
          data = JSON.parse(block.text);
          break;
        } catch {
          /* another block */
        }
      }
  }
  for (let i = 0; i < 5; i++) {
    if (!data || typeof data !== "object" || Array.isArray(data)) break;
    const object = data as Record<string, unknown>;
    if (typeof object.status === "number" && object.status >= 400)
      throw new Error("Tracker readback refused");
    if (object.data !== undefined) data = object.data;
    else if (object.body !== undefined) {
      data = object.body;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          throw new Error("Tracker body is not JSON");
        }
      }
    } else break;
  }
  return data;
}

function verifyRuntimeBinding(
  receipt: AgentReceipt,
  labels: Record<string, string>,
  taskKey: string,
): void {
  const assignedTake = labels.take_comment,
    assignedTask = labels.task;
  if (!assignedTake && !assignedTask)
    throw new Error(
      "Runtime task binding absent; responsible lead must pass the registered task anchor",
    );
  if (assignedTake && assignedTake !== receipt.take_comment)
    throw new Error("Take comment differs from runtime assignment");
  if (assignedTask && assignedTask !== taskKey)
    throw new Error("Tracker task differs from runtime assignment");
}

function sanitizedReadbackError(error: unknown): Error {
  if (error instanceof Error && /^Tracker |^Receipt /.test(error.message)) return error;
  // External transport errors can contain credentials; retain only a safe explanation.
  return new Error("Managed Tracker receipt readback unavailable; transport details suppressed");
}

/** Read-only facts through the same registered managed bridge. Credentials stay
 * in the bridge's memory. Receipt validation never creates Tracker objects. */
export async function verifyTaskReceiptReadback(
  receipt: AgentReceipt,
  labels: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): Promise<{ taskKey: string; issueId: number; takeCommentId: number }> {
  if (!receipt.take_comment) throw new Error("Existing take_comment required");
  const reference = trackerCommentReference(receipt.take_comment);
  verifyRuntimeBinding(receipt, labels, reference.taskKey);
  const command = env.PASEO_TICH_MCP_COMMAND,
    args: unknown = JSON.parse(env.PASEO_TICH_MCP_ARGS ?? "null");
  if (!command?.startsWith("/") || !Array.isArray(args) || args.some((a) => typeof a !== "string"))
    throw new Error("Managed Tracker readback capability unavailable");
  const transport = new StdioClientTransport({ command, args, stderr: "ignore" });
  const client = new Client({ name: "paseo-receipt-hook", version: "1" });
  try {
    await client.connect(transport, { timeout: 20000 });
    const call = async (name: string, arguments_: Record<string, unknown>) =>
      dataOf(await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 20000 }));
    const issue = await call("get_issue_by_number", {
      projectKey: reference.projectKey,
      sequenceNumber: reference.sequenceNumber,
    });
    const issueId = (issue as { id?: unknown })?.id;
    if (typeof issueId !== "number" || !Number.isSafeInteger(issueId))
      throw new Error("Tracker issue readback incomplete");
    const verifyComment = async (id: number) => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 8; page++) {
        const result = await call("list_issue_activity", {
          issueId,
          filter: "comments",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        const object = result as {
          items?: unknown[];
          activities?: unknown[];
          nextCursor?: unknown;
        };
        const rows = Array.isArray(result) ? result : (object?.items ?? object?.activities);
        if (!Array.isArray(rows)) throw new Error("Tracker comment readback incomplete");
        if (
          rows.some(
            (row) =>
              row &&
              typeof row === "object" &&
              ((row as { id?: unknown }).id === id ||
                (row as { comment?: { id?: unknown } }).comment?.id === id),
          )
        )
          return;
        if (object?.nextCursor == null) break;
        if (typeof object.nextCursor !== "string" || seen.has(object.nextCursor))
          throw new Error("Tracker pagination refused");
        cursor = object.nextCursor;
        seen.add(cursor);
      }
      throw new Error("Tracker comment not verified within bounded readback");
    };
    await verifyComment(reference.commentId);
    for (const link of [receipt.completion_comment, receipt.blocker_comment])
      if (link) {
        const target = trackerCommentReference(link);
        if (target.taskKey !== reference.taskKey)
          throw new Error("Receipt comment task binding mismatch");
        await verifyComment(target.commentId);
      }
    return { taskKey: reference.taskKey, issueId, takeCommentId: reference.commentId };
  } catch (error) {
    throw sanitizedReadbackError(error);
  } finally {
    // Confirmed readback survives the known SDK close-only transport failure.
    await client.close().catch(() => undefined);
  }
}
