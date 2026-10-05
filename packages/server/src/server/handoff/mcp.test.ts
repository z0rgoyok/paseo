import { expect, test } from "vitest";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashDaemonPassword } from "../auth.js";
import { HandoffService } from "./service.js";
import { mountHandoffMcp } from "./mcp.js";

test("remote assignment catalog is restricted and survives a repeated tool invocation", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-handoff-http-"));
  const service = new HandoffService(
    directory,
    {
      issuer: "company",
      projects: { project: { cwd: directory, provider: "claude", model: "operator-model" } },
    },
    { initialize: async () => {}, start: async () => {} },
  );
  const app = express();
  app.use(express.json());
  mountHandoffMcp(app, service, hashDaemonPassword("fixture-assignment-key"));
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("TCP listener absent");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp/handoff`);
  const client = new Client({ name: "handoff-contract", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: "Bearer fixture-assignment-key" } },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["paseo_assign"]);
    const args = {
      task_ref: "https://paperclip.example/TIC/issues/TIC-1",
      project: "project",
      objective: "Accepted objective",
      brief: "Accepted scope",
    };
    const first = await client.callTool({ name: "paseo_assign", arguments: args });
    const repeated = await client.callTool({ name: "paseo_assign", arguments: args });
    expect(first.isError).not.toBe(true);
    expect(repeated.structuredContent).toEqual(first.structuredContent);
    const outside = await client.callTool({
      name: "paseo_assign",
      arguments: { ...args, project: "outside" },
    });
    expect(outside.isError).toBe(true);
  } finally {
    await client.close();
    await service.stop();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 20000);
