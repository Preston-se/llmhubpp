import { describe, expect, it, vi } from "vitest";
import { captureSourceReadingContext, prepareSourceReading } from "./sourceReading";
import { memoryVault } from "src/core/testSupport/memoryVault";

describe("source reader ownership", () => {
  it("ignores a selection in another pane and snapshots the selected file", () => {
    const selection = { anchorNode: {}, focusNode: {}, toString: () => "另一页私密选区" };
    const containerEl = { contains: () => false, ownerDocument: { getSelection: () => selection }, querySelectorAll: () => [] };
    const view = { file: { path: "教材.epub", extension: "epub" }, containerEl };
    const context = captureSourceReadingContext(view as never)!;
    expect(context.filePath).toBe("教材.epub"); expect(context.selection).toBe("");
    view.file = { path: "别的.epub", extension: "epub" };
    expect(context.filePath).toBe("教材.epub");
  });
  it("reads the complete chosen material only for an explicit current-material action", async () => {
    const m = memoryVault(); m.files.set("课程.md", "整篇课程原文");
    const context = { filePath: "课程.md", selection: "" };
    expect((await prepareSourceReading(m.app, context, "current")).selection).toBe("整篇课程原文");
    expect((await prepareSourceReading(m.app, context, "knowledge")).selection).toBe("");
  });
  it("does not replace a user's selection with the full source or use a changed reader", async () => {
    const m = memoryVault(); m.files.set("课程.md", "全文");
    expect((await prepareSourceReading(m.app, { filePath: "课程.md", selection: "已选" }, "current")).selection).toBe("已选");
    const view = { file: { path: "别的.md" } };
    await expect(prepareSourceReading(m.app, { filePath: "课程.md", selection: "", sourceView: view } as never, "current")).rejects.toMatchObject({ code: "source-changed" });
  });
});
