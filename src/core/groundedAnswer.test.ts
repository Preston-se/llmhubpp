import { describe, expect, it } from "vitest";
import type { Message } from "src/types";
import { messagesToMarkdown, parseMarkdownToMessages } from "src/ui/components/chat/chatHistory";
import * as rag from "./localRagStore";

const api = rag as unknown as {
  buildGroundedPrompt?: (question: string, retrieval: unknown, limits?: { maxTotalChars?: number; maxChunkChars?: number }) => any;
  attachGroundedEvidence?: (message: Message, evidence: unknown) => Message;
  readGroundedEvidence?: (message: Message) => any;
  inspectGroundedCitations?: (text: string, evidence: unknown) => any;
};
const retrieval = { status: "success", settingName: "Study", query: "原理", results: [
  { filePath: "Study/a.md", text: "细胞膜控制物质进出。", score: 0.9, chunkIndex: 0, sourceStatus: "available" },
  { filePath: "Study/missing.pdf", text: "第二段资料", score: 0.8, chunkIndex: 1, pageLabel: "pages 3-4 of 10", sourceStatus: "missing" },
] };

describe("grounded answers", () => {
  it("builds stable references from the actual selected index excerpts", () => {
    const result = api.buildGroundedPrompt?.("请解释原理", retrieval);
    expect(result).toMatchObject({ evidence: { settingName: "Study", sources: [
      { id: 1, filePath: "Study/a.md", text: "细胞膜控制物质进出。" },
      { id: 2, filePath: "Study/missing.pdf", pageLabel: "pages 3-4 of 10", sourceStatus: "missing" },
    ] } });
    expect(result.systemContext).toContain("请解释原理");
    expect(result.systemContext).toContain("细胞膜控制物质进出。");
    expect(result.systemContext).not.toContain("Other/private.md");
  });

  it("reports excerpts that were shortened or omitted due to the context budget", () => {
    const result = api.buildGroundedPrompt?.("q", retrieval, { maxTotalChars: 8, maxChunkChars: 8 });
    expect(result?.evidence).toMatchObject({ truncated: true, omittedCount: 1 });
    expect(result.evidence.sources[0].text.length).toBeLessThanOrEqual(8);
  });

  it("rejects unready or empty retrieval rather than preparing an unsupported answer", () => {
    expect(api.buildGroundedPrompt).toBeTypeOf("function");
    expect(() => api.buildGroundedPrompt?.("q", { status: "empty" })).toThrow();
  });

  it("keeps evidence through the existing chat-history writer and old parser", async () => {
    const built = api.buildGroundedPrompt?.("q", retrieval);
    const message = api.attachGroundedEvidence?.({ role: "assistant", content: "说明 [1]", timestamp: 123 }, built.evidence);
    expect(message?.ragContexts).toHaveLength(2);
    const markdown = await messagesToMarkdown([message!], "Study", 123, undefined);
    const parsed = parseMarkdownToMessages(markdown);
    expect(api.readGroundedEvidence?.(parsed!.messages[0])).toEqual(built.evidence);
  });

  it("round-trips excerpts containing Markdown comment terminators without corrupting chat history", async () => {
    const special = { ...retrieval, results: [{ ...retrieval.results[0], text: "正文 --> 后续资料" }] };
    const built = api.buildGroundedPrompt?.("q", special);
    const message = api.attachGroundedEvidence?.({ role: "assistant", content: "回答 [1]", timestamp: 123 }, built.evidence);
    const markdown = await messagesToMarkdown([message!], "Study", 123, undefined);
    const parsed = parseMarkdownToMessages(markdown);
    expect(api.readGroundedEvidence?.(parsed!.messages[0])).toEqual(built.evidence);
  });

  it("flags missing or unknown citation numbers without inventing sources", () => {
    const built = api.buildGroundedPrompt?.("q", retrieval);
    expect(api.inspectGroundedCitations?.("没有引用", built.evidence)).toMatchObject({ hasKnown: false, unknown: [] });
    expect(api.inspectGroundedCitations?.("解释 [1] 以及 [9]", built.evidence)).toMatchObject({ hasKnown: true, unknown: [9] });
  });
});
