import { expect, it, vi } from "vitest";
import { createMcpToolExecutor, type McpToolDefinition } from "./mcpTools";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("obsidian-llm-hub-common/mcp", async (load) => ({
  ...await load<typeof import("obsidian-llm-hub-common/mcp")>(),
  createMcpToolExecutor: () => ({ execute, cleanup: async () => {} }),
}));

const search: McpToolDefinition = {
  name: "mcp_deepseek_search_deepseek_web_search", description: "Search",
  parameters: { type: "object", properties: {} }, mcpToolName: "deepseek_web_search",
  mcpServer: { name: "deepseek-search", enabled: true, transport: "stdio",
    command: "node", args: ["D:/test/deepseek-search-mcp.mjs"] },
};

it("keeps unknown search diagnostics out of tool results sent to the model", async () => {
  const executor = createMcpToolExecutor([search]);
  execute.mockResolvedValueOnce({ error: "MCP tool execution failed: stderr contains synthetic-credential" });
  const result = await executor.execute(search.name, { query: "Public docs" });
  expect(result.error).toBe("MCP tool execution failed: DeepSeek search failed. Check the MCP server connection.");
  expect(result.error).not.toContain("synthetic-credential");
});

it("keeps recognized safe search status and limits filtering to the configured search adapter", async () => {
  const other = { ...search, name: "mcp_other_search", mcpServer: { ...search.mcpServer, args: ["other.mjs"] } };
  const executor = createMcpToolExecutor([search, other]);
  execute.mockResolvedValueOnce({ error: 'MCP tool execution failed: {"error":"DeepSeek search returned HTTP 429"}' })
    .mockResolvedValueOnce({ error: "The other tool requires a numeric argument" });
  await expect(executor.execute(search.name, {})).resolves.toEqual({ error: "MCP tool execution failed: DeepSeek search returned HTTP 429" });
  await expect(executor.execute(other.name, {})).resolves.toEqual({ error: "The other tool requires a numeric argument" });
});
