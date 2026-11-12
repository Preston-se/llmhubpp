import { beforeEach, describe, expect, it, vi } from "vitest";
import { type GroundedEvidence } from "src/core/groundedAnswer";

const status = vi.hoisted(() => vi.fn());
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useState: (value: unknown) => [value, vi.fn()] }));
vi.mock("src/core/ragSourceStatus", () => ({ getRagSourceStatus: status }));
vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("src/ui/ChatView", () => ({ ChatView: class {}, VIEW_TYPE_GEMINI_CHAT: "chat" }));
import { openCitationSource } from "./chat/sourceNavigation";

const evidence: GroundedEvidence = { version: 1, settingName: "A", query: "q", omittedCount: 0, truncated: false,
  sources: [{ id: 1, filePath: "Study/book.pdf", chunkIndex: 0, text: "文本", pageLabel: "pages 3-4 of 9", sourceStatus: "available", truncated: false }] };
beforeEach(() => status.mockReset());

describe("open an answer's actual source", () => {
  it("rechecks the source and opens the indexed PDF page", async () => {
    status.mockResolvedValue("available"); const openLinkText = vi.fn();
    await openCitationSource({ vault: { adapter: {} }, workspace: { openLinkText } } as never, evidence.sources[0]);
    expect(status).toHaveBeenCalledWith(expect.anything(), "Study/book.pdf");
    expect(openLinkText).toHaveBeenCalledWith("Study/book.pdf#page=3", "", false);
  });

  it("does not open a source that disappeared since the answer was generated", async () => {
    status.mockResolvedValue("missing"); const openLinkText = vi.fn();
    await openCitationSource({ vault: { adapter: {} }, workspace: { openLinkText } } as never, evidence.sources[0]);
    expect(openLinkText).not.toHaveBeenCalled();
  });
});
