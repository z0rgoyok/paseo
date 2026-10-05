import { describe, expect, test } from "vitest";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { withRuntimeTichMcpServer } from "./runtime-tich-bootstrap.js";

const env = { PASEO_TICH_MCP_COMMAND: "/app/python", PASEO_TICH_MCP_ARGS: '["-B","/managed/tich-mcp.py"]' };
const config = (provider: string): AgentSessionConfig => ({ provider, cwd: "/work", model: "chosen", modeId: "chosen-mode", thinkingOptionId: "chosen-effort" });

describe("managed Tich bootstrap", () => {
  test.each(["codex", "claude"])("injects into %s without changing explicit settings", (provider) => {
    const before = config(provider);
    const after = withRuntimeTichMcpServer(before, env);
    expect(after).toEqual({ ...before, ...(provider === "codex" ? {providerOptions: {model_context_window: 1000000, model_auto_compact_token_limit: 900000}} : {}), mcpServers: { itsaplan: { type: "stdio", command: "/app/python", args: ["-B", "/managed/tich-mcp.py"] } } });
    expect(before.mcpServers).toBeUndefined();
    expect(withRuntimeTichMcpServer(after, env)).toEqual(after);
  });
  test("preserves existing MCP and opts out outside the managed installation", () => {
    const before = { ...config("codex"), mcpServers: { other: { type: "http" as const, url: "https://other/mcp" } } };
    expect(withRuntimeTichMcpServer(before, {})).toBe(before);
    expect(withRuntimeTichMcpServer(before, env).mcpServers?.other).toEqual(before.mcpServers.other);
  });
  test("fails closed for partial config, malformed args and conflicting access", () => {
    for (const bad of [{ PASEO_TICH_MCP_COMMAND: "/app/python" }, { PASEO_TICH_MCP_ARGS: "[]" }, { ...env, PASEO_TICH_MCP_ARGS: '{}' }, { ...env, PASEO_TICH_MCP_ARGS: '[1]' }, { ...env, PASEO_TICH_MCP_COMMAND: 'python' }]) {
      expect(() => withRuntimeTichMcpServer(config("pi"), bad)).toThrow();
    }
    expect(() => withRuntimeTichMcpServer({ ...config("claude"), mcpServers: { itsaplan: { type: "http", url: "https://other/mcp" } } }, env)).toThrow("conflicts");
  });
  test("enforces omitted default and actual Codex permission options", () => {
    const before = { ...config("codex"), modeId: undefined, providerOptions: { approval_policy: "on-request", sandbox_mode: "read-only" } };
    const after = withRuntimeTichMcpServer(before, env);
    expect(after.modeId).toBe("full-access");
    expect(after.providerOptions).toMatchObject({ approval_policy: "never", sandbox_mode: "danger-full-access" });
    expect(after.model).toBe(before.model);
    expect(after.thinkingOptionId).toBe(before.thinkingOptionId);
    expect(withRuntimeTichMcpServer({ ...config("claude"), modeId: "default" }, env).modeId).toBe("bypassPermissions");
  });
  test("injects Tracker into Pi without inventing a selectable mode", () => {
    const result = withRuntimeTichMcpServer({ ...config("pi"), modeId: undefined }, env);
    expect(result.modeId).toBeUndefined();
    expect(result.mcpServers?.itsaplan).toMatchObject({type: "stdio", command: "/app/python"});
  });
});
