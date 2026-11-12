import { beforeEach, describe, expect, it, vi } from "vitest";
import * as answer from "./groundedAnswer";

const stub = vi.hoisted(() => ({ retrieve: vi.fn(), extract: vi.fn() }));
vi.mock("./groundedRetrieval", () => ({ retrieveGroundedContext: stub.retrieve }));
vi.mock("obsidian-llm-hub-common/vault", () => ({ extractPdfText: stub.extract }));

const success = { status: "success", settingName: "Study", query: "topic", results: [
  { filePath: "Study/a.pdf", text: "[Pdf: a.pdf]", chunkIndex: 0, score: 0.9, contentType: "pdf", pageLabel: "pages 3-4 of 10", sourceStatus: "available" },
] };

beforeEach(() => { stub.retrieve.mockReset().mockResolvedValue(success); stub.extract.mockReset(); });

describe("grounded answer preparation", () => {
  it("extracts actual PDF text instead of treating an index filename label as evidence", async () => {
    stub.extract.mockResolvedValue("第三页的真实正文");
    const prepare = (answer as unknown as { prepareGroundedAnswer?: (request: unknown) => Promise<any> }).prepareGroundedAnswer;
    const result = await prepare?.({ app: {}, query: "topic" });
    expect(result).toMatchObject({ status: "ready", prompt: { evidence: { sources: [{ text: "第三页的真实正文" }] } } });
    expect(stub.extract).toHaveBeenCalledWith({}, "Study/a.pdf", 3, 4);
    expect(result.prompt.systemContext).not.toContain("[Pdf: a.pdf]");
  });

  it("does not produce an answer request when no retrieved result has readable text", async () => {
    stub.extract.mockResolvedValue("");
    const prepare = (answer as unknown as { prepareGroundedAnswer?: (request: unknown) => Promise<any> }).prepareGroundedAnswer;
    expect(await prepare?.({ app: {}, query: "topic" })).toMatchObject({ status: "not-ready", reason: "no-readable-text" });
  });

  it("preserves a no-match result without attempting PDF extraction", async () => {
    stub.retrieve.mockResolvedValue({ status: "empty", settingName: "Study", query: "topic" });
    const prepare = (answer as unknown as { prepareGroundedAnswer?: (request: unknown) => Promise<any> }).prepareGroundedAnswer;
    expect(await prepare?.({ app: {}, query: "topic" })).toMatchObject({ status: "empty" });
    expect(stub.extract).not.toHaveBeenCalled();
  });
});
