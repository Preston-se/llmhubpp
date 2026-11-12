import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "src/types";
import { CodexVaultMcpBridge } from "./codexVaultMcpBridge";
import { applyToolActivityEvent, type ToolActivityState } from "src/ui/components/chat/toolActivity";

const tool: ToolDefinition = {
  name: "propose_edit",
  description: "Propose an edit",
  parameters: {
    type: "object",
    properties: { fileName: { type: "string" } },
    required: ["fileName"],
  },
};

describe("CodexVaultMcpBridge", () => {
  it("lists only the tools supplied by the plugin", async () => {
    const bridge = new CodexVaultMcpBridge([tool], vi.fn());
    const result = await bridge.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(result).toEqual({
      tools: [{
        name: "propose_edit",
        description: "Propose an edit",
        inputSchema: tool.parameters,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      }],
    });
  });

  it("marks Obsidian read tools as read-only and idempotent", async () => {
    const readTool: ToolDefinition = { ...tool, name: "read_note" };
    const bridge = new CodexVaultMcpBridge([readTool], vi.fn());
    const result = await bridge.handleRequest({ jsonrpc: "2.0", id: 5, method: "tools/list" });

    expect(result).toMatchObject({ tools: [{ annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    } }] });
  });

  it("routes a mutation through the confirmation executor", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, applied: true });
    const bridge = new CodexVaultMcpBridge([tool], execute);
    const result = await bridge.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "propose_edit", arguments: { fileName: "Note.md" } },
    });

    expect(execute).toHaveBeenCalledWith("propose_edit", { fileName: "Note.md" });
    expect(result).toMatchObject({ structuredContent: { applied: true } });
    expect(result).not.toHaveProperty("isError");
  });

  it("reports MCP tool calls to the chat observer", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, content: "PDF text" });
    const observe = vi.fn();
    const bridge = new CodexVaultMcpBridge([{ ...tool, name: "read_note" }], execute);
    bridge.setToolCallObserver(observe);

    await bridge.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "read_note", arguments: { fileName: "docs/manual.pdf" } },
    });

    expect(observe).toHaveBeenCalledWith(
      "read_note",
      { fileName: "docs/manual.pdf" },
      { success: true, content: "PDF text" },
    );
  });

  it("reports a tool starting and its matching result to the original turn", async () => {
    let finish!: (value: Record<string, unknown>) => void;
    const bridge = new CodexVaultMcpBridge([tool], () => new Promise(resolve => { finish = resolve; }));
    const first = vi.fn(), later = vi.fn();
    const withActivity = bridge as unknown as { setToolActivityObserver?: (observer: (chunk: any) => void) => void };
    withActivity.setToolActivityObserver?.(first);
    const pending = bridge.handleRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "propose_edit", arguments: { fileName: "private.md" } } });
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_call", toolCall: expect.objectContaining({ name: "propose_edit", args: {} }) }));
    const id = first.mock.calls[0][0].toolCall.id;
    withActivity.setToolActivityObserver?.(later);
    finish({ success: true }); await pending;
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ type: "tool_result", toolResult: expect.objectContaining({ toolCallId: id }) }));
    expect(later).not.toHaveBeenCalled();
  });

  it("does not call an ambiguous MCP tool result successful in the activity display", async () => {
    const bridge = new CodexVaultMcpBridge([tool], vi.fn().mockResolvedValue({ pending: true, private: "secret" }));
    const owner = { sessionId: 1, turnId: 1 };
    let state: ToolActivityState | null = { ...owner, items: [] };
    bridge.setToolActivityObserver(chunk => { state = applyToolActivityEvent(state, owner, chunk); });
    const result = await bridge.handleRequest({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "propose_edit", arguments: {} } });
    expect((state as ToolActivityState | null)?.items[0].status).toBe("unconfirmed");
    expect(result).not.toHaveProperty("isError");
    expect(result).toMatchObject({ structuredContent: { pending: true } });
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("rejects tools that were not explicitly exposed", async () => {
    const execute = vi.fn();
    const bridge = new CodexVaultMcpBridge([tool], execute);
    const result = await bridge.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "apply_edit", arguments: {} },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it("updates the exposed tools when active skills change", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const bridge = new CodexVaultMcpBridge([tool], execute);
    const skillTool: ToolDefinition = {
      name: "run_skill_workflow",
      description: "Run an active skill workflow",
      parameters: { type: "object", properties: {} },
    };

    bridge.setTools([tool, skillTool]);
    const result = await bridge.handleRequest({ jsonrpc: "2.0", id: 4, method: "tools/list" });

    expect(result).toMatchObject({
      tools: [
        { name: "propose_edit" },
        { name: "run_skill_workflow" },
      ],
    });
  });
});
