import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { extractHttpBearerToken, isBearerTokenValidAsync } from "../auth.js";
import { AssignmentSchema, AssignmentReceiptSchema } from "./contract.js";
import type { HandoffService } from "./service.js";

export function mountHandoffMcp(app: Express, service: HandoffService, tokenHash: string): void {
  app.post("/mcp/handoff", (req, res) => {
    void (async () => {
      // This route bypasses daemon auth and must validate its own scoped key.
      if (
        !(await isBearerTokenValidAsync({
          password: tokenHash,
          token: extractHttpBearerToken(req.header("authorization")),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const server = new McpServer({ name: "paseo-assignment", version: "1" });
      server.registerTool(
        "paseo_assign",
        {
          title: "Assign work to Paseo",
          description:
            "Make the first assignment once. Paseo owns execution, goals and coordination. Reuse task_ref when a reply is lost. Accepted confirms durable ownership, not a completed or running task.",
          inputSchema: AssignmentSchema.shape,
          outputSchema: AssignmentReceiptSchema.shape,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        async (input) => {
          const receipt = await service.assign(input);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
            structuredContent: receipt,
          };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: false,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    })().catch(() => {
      if (res.headersSent) res.destroy();
      else
        res.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Assignment transport unavailable" },
        });
    });
  });
}
