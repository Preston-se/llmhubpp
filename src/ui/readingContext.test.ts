import { describe, expect, it, vi } from "vitest";
import { captureReadingContext, insertReadingResults, registerReadingMenuItems } from "./readingContext";

function fixture() {
  let content = "开头\n选中的句子\n结尾";
  const editor = { getValue: () => content, getSelection: () => "选中的句子", getCursor: (which: string) => which === "from" ? { line: 1, ch: 0 } : { line: 1, ch: 5 },
    replaceRange: vi.fn((text: string) => { content += text; }) };
  const file = { path: "学习/笔记.md", extension: "md" };
  const view = { file, editor };
  const app = { workspace: { getLeavesOfType: () => [{ view }] }, vault: { getAbstractFileByPath: (_path: string): typeof file | null => file } };
  return { editor, file, view, app, change: (value: string) => { content = value; }, text: () => content };
}
const excerpts = [
  { filePath: "资料/教材.md", text: "第一条\n第二行", chunkIndex: 0, score: 1 },
  { filePath: "资料/原书.pdf", text: "页内正文", chunkIndex: 2, score: 0.9, pageLabel: "pages 3-4 of 12", contentType: "pdf" },
];

describe("reading context insertion", () => {
  it("inserts selected excerpts and actual source information after the original selection", () => {
    const f = fixture(); const context = captureReadingContext(f.editor as never, f.view as never)!;
    expect(insertReadingResults(f.app as never, context, excerpts)).toBe("inserted");
    expect(f.editor.replaceRange).toHaveBeenCalledOnce();
    const [text, location] = f.editor.replaceRange.mock.calls[0];
    expect(location).toEqual({ line: 1, ch: 5 });
    expect(text).toContain("> 第一条\n> 第二行");
    expect(text).toContain("资料/教材.md");
    expect(text).toContain("资料/原书.pdf");
    expect(text).toContain("pages 3-4 of 12");
  });

  it.each(["changed", "renamed", "closed", "switched", "deleted"])("does not write if the target was %s", condition => {
    const f = fixture(); const context = captureReadingContext(f.editor as never, f.view as never)!;
    if (condition === "changed") f.change("different text");
    if (condition === "renamed") f.file.path = "学习/新名字.md";
    if (condition === "closed") f.app.workspace.getLeavesOfType = () => [];
    if (condition === "switched") f.view.file = { path: "另一篇.md", extension: "md" };
    if (condition === "deleted") f.app.vault.getAbstractFileByPath = () => null;
    expect(insertReadingResults(f.app as never, context, excerpts)).toBe("target-changed");
    expect(f.editor.replaceRange).not.toHaveBeenCalled();
  });

  it("does not insert an unreadable PDF filename placeholder as an excerpt", () => {
    const f = fixture(); const context = captureReadingContext(f.editor as never, f.view as never)!;
    expect(insertReadingResults(f.app as never, context, [{ ...excerpts[1], text: "[Pdf: 原书.pdf]" }])).toBe("unreadable");
    expect(f.editor.replaceRange).not.toHaveBeenCalled();
  });

  it("captures the selection at menu creation and exposes three independent actions", () => {
    const f = fixture(); const actions = { search: vi.fn(), current: vi.fn(), knowledge: vi.fn() };
    const items: Array<{ title: string; click?: () => void }> = [];
    const menu = { addItem(callback: (item: any) => void) { const state = { title: "", click: undefined as (() => void) | undefined };
      const item = { setTitle(title: string) { state.title = title; return item; }, setIcon() { return item; }, onClick(click: () => void) { state.click = click; return item; } };
      callback(item); items.push(state); } };
    registerReadingMenuItems(menu as never, f.editor as never, f.view as never, actions);
    expect(items).toHaveLength(3);
    items[0].click?.(); items[1].click?.(); items[2].click?.();
    expect(actions.search).toHaveBeenCalledWith(expect.objectContaining({ filePath: "学习/笔记.md", selection: "选中的句子" }));
    expect(actions.current).toHaveBeenCalledOnce();
    expect(actions.knowledge).toHaveBeenCalledOnce();
  });
});
