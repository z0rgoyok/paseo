import { expect, test } from "vitest";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { hashDaemonPassword } from "../auth.js";
import { AssignmentReceiptSchema } from "./contract.js";

test("daemon handoff uses the operator profile, registers an active goal and isolates its key", async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), "handoff-daemon-"));
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome: home,
      agentStoragePath: path.join(home, "agents"),
      corsAllowedOrigins: [],
      hostnames: true,
      relayEnabled: false,
      mcpEnabled: true,
      mcpInjectIntoAgents: true,
      staticDir: home,
      persistLocalCredential: false,
      auth: { password: hashDaemonPassword("fixture-admin-key") },
      handoffToken: "fixture-assignment-key",
      handoff: {
        issuer: "company",
        projects: {
          project: { cwd: home, provider: "claude", model: "operator-model" },
        },
      },
      agentClients: createTestAgentClients(),
    },
    pino({ level: "silent" }),
  );
  const client = new Client({ name: "handoff-wiring-contract", version: "1" });
  try {
    await daemon.start();
    const target = daemon.getListenTarget();
    if (target?.type !== "tcp") throw new Error("TCP target absent");
    const base = `http://127.0.0.1:${target.port}`;
    expect((await fetch(base + "/mcp/handoff", { method: "POST" })).status).toBe(401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp/handoff"), {
        requestInit: { headers: { Authorization: "Bearer fixture-assignment-key" } },
      }),
    );
    const args = {
      task_ref: "https://paperclip.example/TIC/issues/TIC-1",
      project: "project",
      objective: "Registered assignment objective",
      brief: "Accepted scope",
    };
    const first = await client.callTool({ name: "paseo_assign", arguments: args });
    expect(first.isError).not.toBe(true);
    const receipt = AssignmentReceiptSchema.parse(first.structuredContent);
    await expect
      .poll(
        async () => {
          const response = await fetch(base + "/api/handoffs/" + receipt.handoff_id, {
            headers: { Authorization: "Bearer fixture-admin-key" },
          });
          return z.object({ phase: z.string() }).parse(await response.json()).phase;
        },
        { timeout: 10000 },
      )
      .toBe("started");
    expect(await daemon.agentManager.getAgentGoal(receipt.executor_id)).toMatchObject({
      status: "active",
      objective: args.objective,
      engine: "manager",
    });
    expect(daemon.agentManager.getAgent(receipt.executor_id)).toMatchObject({
      provider: "claude",
      cwd: home,
      config: { model: "operator-model", modeId: "bypassPermissions" },
      currentModeId: "bypassPermissions",
    });
    expect(
      (await client.callTool({ name: "paseo_assign", arguments: args })).structuredContent,
    ).toEqual(receipt);
    expect(
      (
        await fetch(base + "/api/handoffs/" + receipt.handoff_id, {
          headers: { Authorization: "Bearer fixture-assignment-key" },
        })
      ).status,
    ).toBe(401);
    expect(await fs.readFile(path.join(home, "config.json"), "utf8")).not.toContain(
      "fixture-assignment-key",
    );
  } finally {
    await client.close();
    await daemon.stop();
    await fs.rm(home, { recursive: true, force: true });
  }
}, 60000);
