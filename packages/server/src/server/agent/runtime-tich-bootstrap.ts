import type { AgentSessionConfig, McpStdioServerConfig } from "./agent-sdk-types.js";

/** Managed remote installation. This configuration contains paths, never credentials. */
export function withRuntimeTichMcpServer(
  config: AgentSessionConfig,
  env: Record<string, string | undefined> = process.env,
): AgentSessionConfig {
  const command = env.PASEO_TICH_MCP_COMMAND;
  const rawArgs = env.PASEO_TICH_MCP_ARGS;
  if (command === undefined && rawArgs === undefined) return config;
  if (!command?.startsWith("/") || rawArgs === undefined) {
    throw new Error("Managed Tich MCP bootstrap requires an absolute command and JSON args");
  }
  const args: unknown = JSON.parse(rawArgs);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Managed Tich MCP bootstrap args must be strings");
  }
  const managed: McpStdioServerConfig = { type: "stdio", command, args };
  // Pi exposes no selectable permission mode; retain its native host execution.
  const needsDefaultMode = config.modeId === undefined || config.modeId === "default";
  const modeId = needsDefaultMode
    ? config.provider === "codex" ? "full-access"
      : config.provider === "claude" ? "bypassPermissions" : config.modeId
    : config.modeId;
  if (needsDefaultMode && !["codex", "claude", "pi"].includes(config.provider)) {
    throw new Error(`Managed full-permission admission unsupported for provider '${config.provider}'`);
  }
  const existing = config.mcpServers?.itsaplan;
  if (existing && (existing.type !== "stdio" || existing.command !== command ||
    JSON.stringify(existing.args ?? []) !== JSON.stringify(args) ||
    Object.keys(existing.env ?? {}).length > 0)) {
    throw new Error("Agent Tich MCP configuration conflicts with managed bootstrap");
  }
  return {
    ...config,
    ...(modeId ? { modeId } : {}),
    ...(config.provider === "codex" ? {
      providerOptions: {
        ...config.providerOptions,
        ...(modeId === "full-access" ? { approval_policy: "never", sandbox_mode: "danger-full-access" } : {}),
        model_context_window: 1000000,
        model_auto_compact_token_limit: 900000,
      },
    } : {}),
    mcpServers: { ...config.mcpServers, itsaplan: managed },
  };
}
