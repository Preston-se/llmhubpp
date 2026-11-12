import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import MessageBubble from "./MessageBubble";
import type { Message } from "src/types";

vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("src/ui/ChatView", () => ({ ChatView: class {}, VIEW_TYPE_GEMINI_CHAT: "chat" }));

describe("chat tool execution results", () => {
  it("shows a scope denial even if the assistant text claims the note was created", () => {
    const message: Message = {
      role: "assistant", timestamp: 1, content: "The note was created.",
      toolCalls: [{ id: "call-1", name: "create_note", args: { name: "test" } }],
      toolResults: [{ toolCallId: "call-1", result: { success: false,
        error: "Access denied: LLM vault tools are limited to the configured allowed folders.",
        allowedFolders: ["Study"] } }],
    };
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(markup).toContain("message.toolFailure.scope");
    expect(markup).toContain("Study");
    expect(markup).not.toContain("Created: test");
  });

  it("does not claim a create succeeded when there is no matching result", () => {
    const message: Message = { role: "assistant", timestamp: 1, content: "Done.",
      toolCalls: [{ id: "call-1", name: "create_note", args: { name: "test" } }] };
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(markup).toContain("message.toolFailure.unconfirmed");
    expect(markup).not.toContain("Created: test");
  });

  it("shows generic failures without exposing raw errors or credentials", () => {
    const message: Message = { role: "assistant", timestamp: 1, content: "",
      toolCalls: [{ id: "call-1", name: "create_note", args: {} }],
      toolResults: [{ toolCallId: "call-1", result: { success: false, error: "Bearer SECRET" } }] };
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(markup).toContain("message.toolFailure.generic");
    expect(markup).not.toContain("SECRET");
  });

  it.each([
    ["invalid", "message.toolFailure.mcpApprovalSave"],
    ["MCP tool approval could not be saved", "message.toolFailure.mcpApprovalSave"],
    ['{"error":"DeepSeek returned an invalid search response."}', "message.toolFailure.mcpSearchInvalid"],
    ['{"error":"DeepSeek search could not verify the HTTPS certificate (SELF_SIGNED_CERT_IN_CHAIN)."}', "message.toolFailure.mcpSearchCertificate"],
    ['{"error":"DeepSeek search returned HTTP 401"}', "message.toolFailure.mcpSearchAuthentication"],
    ["Bearer PRIVATE", "message.toolFailure.mcp"],
  ])("shows a safe search failure reason for %s", (failure, label) => {
    const message: Message = { role: "assistant", timestamp: 1, content: "",
      toolCalls: [{ id: "search", name: "mcp_deepseek_search_deepseek_web_search", args: {} }],
      toolResults: [{ toolCallId: "search", result: { error: `MCP tool execution failed: ${failure}` } }] };
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(markup).toContain(label);
    expect(markup).not.toContain("PRIVATE");
  });

  it("keeps the normal created badge when the executor confirms success", () => {
    const message: Message = { role: "assistant", timestamp: 1, content: "",
      toolCalls: [{ id: "call-1", name: "create_note", args: { name: "test" } }],
      toolResults: [{ toolCallId: "call-1", result: { success: true, path: "Study/test.md" } }] };
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(markup).toContain("Created");
    expect(markup).not.toContain("message.toolFailure");
  });
});
