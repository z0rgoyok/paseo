import { expect, test } from "vitest";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { hashDaemonPassword } from "../auth.js";

function goalStatus(value: unknown) {
  return z.object({ goal: z.object({ status: z.string() }) }).parse(value).goal.status;
}

test("native MCP exposes manager goal/receipt readback, pause and own-review completion without plaintext credential files", async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), "goal-mcp-candidate-"));
  const password = "test-only-memory-password";
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome: home,
      agentStoragePath: path.join(home, "agents"),
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      mcpInjectIntoAgents: true,
      relayEnabled: false,
      staticDir: home,
      persistLocalCredential: false,
      auth: { password: hashDaemonPassword(password) },
      agentClients: createTestAgentClients(),
    },
    pino({ level: "silent" }),
    { verifyTaskReceipt: async () => ({ taskKey: "TEST-1", issueId: 1, takeCommentId: 7 }) },
  );
  let client: Client | undefined;
  try {
    await daemon.start();
    const target = daemon.getListenTarget();
    if (target?.type !== "tcp") throw new Error("TCP target absent");
    client = new Client({ name: "manager-goal-contract", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${target.port}/mcp/agents`), {
        requestInit: { headers: { Authorization: `Bearer ${password}` } },
      }),
    );
    const actor = await daemon.agentManager.createAgent(
      { provider: "claude", cwd: home, modeId: "bypassPermissions" },
      undefined,
      { labels: { role: "reviewer", task: "TEST-1" } },
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return z.record(z.string(), z.unknown()).parse(result.structuredContent);
    };
    const created = await call("set_agent_goal", {
      agentId: actor.id,
      objective: "Submit only exact review artifact",
      maxTurns: 4,
    });
    expect(created.goal).toMatchObject({
      engine: "manager",
      agentId: actor.id,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
    });
    await daemon.agentManager.runAgent(actor.id, "review first");
    await call("update_agent_goal", { agentId: actor.id, status: "paused" });
    expect(goalStatus(await call("get_agent_goal", { agentId: actor.id }))).toBe("paused");
    await call("update_agent_goal", { agentId: actor.id, status: "active" });
    const text = "reviewed candidate exact revision";
    await fs.writeFile(path.join(home, "review.md"), text);
    const receipt = {
      receipt_type: "review_completed",
      take_comment: "https://tracker.tich.app/project/TEST/issue/1#comment-7",
      review_artifact: {
        path: "review.md",
        sha256: createHash("sha256").update(text).digest("hex"),
      },
      verdict: "approved",
    };
    const result = await call("submit_agent_receipt", { agentId: actor.id, receipt });
    expect(result.status).toBe("processed");
    expect(goalStatus(result.result)).toBe("complete");
    expect((await call("submit_agent_receipt", { agentId: actor.id, receipt })).receipt_id).toBe(
      result.receipt_id,
    );
    expect(goalStatus(await call("get_agent_goal", { agentId: actor.id }))).toBe("complete");
    expect(
      await fs.stat(path.join(home, "local-credential")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect((await fs.readFile(path.join(home, "config.json"), "utf8")).includes(password)).toBe(
      false,
    );
  } finally {
    await client?.close();
    await daemon.stop();
    await fs.rm(home, { recursive: true, force: true });
  }
}, 60000);
