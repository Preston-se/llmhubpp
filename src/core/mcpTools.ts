import {
  createMcpToolExecutor as createSharedExecutor,
  type McpToolDefinition,
  type McpToolExecutor,
} from "obsidian-llm-hub-common/mcp";
import type { McpServerConfig } from "../types";

export {
  fetchMcpTools,
  isMcpTool,
  clearMcpToolsCache,
  getMcpAppResourceUri,
  type McpToolDefinition,
  type McpToolResult,
  type McpToolExecutor,
} from "obsidian-llm-hub-common/mcp";

export function isDeepSeekSearchAdapter(server: McpServerConfig, tool: string): boolean {
  return server.transport === "stdio" && tool === "deepseek_web_search" &&
    server.args?.some(arg => /(?:^|[\\/])deepseek-search-mcp\.mjs$/i.test(arg)) === true;
}

const SEARCH_FAILURE_MESSAGES = [
  "MCP tool approval could not be saved",
  "MCP server settings changed during approval",
  "MCP tool call denied by user:",
  "Configure DEEPSEEK_API_KEY in the MCP server settings.",
  "DeepSeek returned an invalid search response.",
  "DeepSeek search could not verify the HTTPS certificate",
  "Could not reach DeepSeek search",
  "MCP request timed out",
  "Enter a query of 1–128 characters and an optional count from 1 to 50.",
];

export function createMcpToolExecutor(
  tools: McpToolDefinition[], traceId?: string | null, skipApproval = false,
): McpToolExecutor {
  const executor = createSharedExecutor(tools, traceId, skipApproval);
  const registeredTools = new Map(tools.map(tool => [tool.name, tool]));
  const searchTools = new Set([...registeredTools.values()]
    .filter(tool => isDeepSeekSearchAdapter(tool.mcpServer, tool.mcpToolName)).map(tool => tool.name));
  if (!searchTools.size) return executor;
  return {
    cleanup: executor.cleanup,
    execute: async (name, args) => {
      const result = await executor.execute(name, args);
      const { error } = result;
      if (!error || !searchTools.has(name)) return result;
      // The next model round receives this error. Keep known causes without stderr or remote text.
      const http = error.match(/DeepSeek search returned HTTP [1-5]\d{2}\b/)?.[0];
      const message = http ?? SEARCH_FAILURE_MESSAGES.find(text => error.includes(text))
        ?? "DeepSeek search failed. Check the MCP server connection.";
      return { ...result, error: "MCP tool execution failed: " + message };
    },
  };
}
