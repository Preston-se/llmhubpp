import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { attachGroundedEvidence, type GroundedEvidence } from "src/core/groundedAnswer";
import MessageBubble from "./MessageBubble";

vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("src/ui/ChatView", () => ({ ChatView: class {}, VIEW_TYPE_GEMINI_CHAT: "chat" }));

const evidence: GroundedEvidence = { version: 1, settingName: "专业资料", query: "question", omittedCount: 1, truncated: true,
  sources: [{ id: 1, filePath: "Study/guide.pdf", chunkIndex: 2, text: "这是实际发送给模型的摘录", pageLabel: "pages 3-4", sourceStatus: "missing", truncated: true }] };

describe("grounded answer evidence", () => {
  it("keeps uncited excerpts out of the transcript and reports citation problems", () => {
    const message = attachGroundedEvidence({ role: "assistant", timestamp: 1, content: "结论 [1] [8]" }, evidence);
    const html = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(html).toContain("专业资料");
    expect(html).not.toContain("这是实际发送给模型的摘录");
    expect(html).toContain("message.grounded.unknownCitation");
    expect(html).toContain("message.grounded.shortened");
  });

  it("warns when no citation matches the supplied evidence", () => {
    const message = attachGroundedEvidence({ role: "assistant", timestamp: 1, content: "没有引用。" }, evidence);
    const html = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(html).toContain("message.grounded.noCitation");
  });
  it("retains snippet-only legacy citation history without inferring answer numbering", () => {
    const message = { role: 'assistant' as const, timestamp: 1, content: '旧回答 [1]', ragUsed: true,
      ragCitations: [{ filePath: 'Archive/old.md', heading: '旧章节', startOffset: 35, snippet: '历史片段仍可查看' }] };
    const html = renderToStaticMarkup(createElement(MessageBubble, { message, app: {} as App }));
    expect(html).toContain('Archive/old.md');
    expect(html).toContain('历史片段仍可查看');
    expect(html).not.toContain('llm-hub-citation-mark');
  });
});
