import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { LlmHubPlugin } from "src/plugin";
import { TaskManager } from "src/core/taskManager";

const harness = vi.hoisted(() => {
  const state: {
    slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }>;
    cursor: number; dirty: boolean; effects: Array<() => void>;
    search: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; indexed: ReturnType<typeof vi.fn>; pdf: ReturnType<typeof vi.fn>; pdfText: ReturnType<typeof vi.fn>; sourceStatus: ReturnType<typeof vi.fn>;
    notices: string[];
  } = { slots: [], cursor: 0, dirty: false, effects: [], search: vi.fn(), status: vi.fn(), indexed: vi.fn(), pdf: vi.fn(), pdfText: vi.fn(), sourceStatus: vi.fn(), notices: [] };
  return state;
});

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!harness.slots[index]) harness.slots[index] = { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      return [harness.slots[index].value, (next: unknown) => {
        const old = harness.slots[index].value;
        const value = typeof next === "function" ? (next as (old: unknown) => unknown)(old) : next;
        if (!Object.is(old, value)) { harness.slots[index].value = value; harness.dirty = true; }
      }];
    },
    useRef: (value: unknown) => {
      const index = harness.cursor++;
      if (!harness.slots[index]) harness.slots[index] = { value: { current: value } };
      return harness.slots[index].value;
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const index = harness.cursor++;
      const previous = harness.slots[index];
      if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((v, i) => Object.is(v, previous.deps![i]))) return;
      harness.slots[index] = { deps };
      harness.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); if (cleanup) harness.slots[index].cleanup = cleanup; });
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const index = harness.cursor++;
      const previous = harness.slots[index];
      if (previous?.deps && deps.length === previous.deps.length && deps.every((v, i) => Object.is(v, previous.deps![i]))) return previous.value;
      harness.slots[index] = { value: fn, deps };
      return fn;
    },
  };
});

vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("obsidian", async importOriginal => ({ ...await importOriginal<typeof import("obsidian")>(),
  Notice: class { constructor(message: string) { harness.notices.push(message); } },
}));
vi.mock("src/types", () => ({
  getGeminiApiKey: () => "key", DEFAULT_RAG_SETTING: { topK: 5, scoreThreshold: 0, chunkSize: 500, chunkOverlap: 100, pdfChunkPages: 6 },
  CLI_MODEL: {}, CLAUDE_CLI_MODEL: {}, CODEX_CLI_MODEL: {}, localLlmDisplayName: () => "",
}));
vi.mock("src/core/localRagStore", () => ({
  getLocalRagStore: () => ({ getStatus: harness.status, getIndexedFiles: harness.indexed }), searchLocalRagResults: harness.search,
  extractPdfPages: harness.pdf, loadRagMediaAttachments: vi.fn(),
}));
vi.mock("src/core/ragSourceStatus", () => ({ getRagSourceStatus: harness.sourceStatus }));
vi.mock("obsidian-llm-hub-common/vault", () => ({ extractPdfText: harness.pdfText }));
vi.mock("./pdfResultModePreference", () => ({ getPdfResultModePreference: () => "text", setPdfResultModePreference: vi.fn() }));
vi.mock("./searchUtils", () => ({ parseFilterTerms: () => [], matchesFilter: () => true, removeRedundantTerms: (s: string) => s }));
vi.mock("./RagChunkEditModal", () => ({ RagChunkEditModal: class {} }));
vi.mock("src/core/embeddingProvider", () => ({ extensionToMimeType: () => "" }));
vi.mock("src/core/modelStreaming", () => ({ streamChatForModel: vi.fn() }));

import SearchPanel from "./SearchPanel";

function find(node: unknown, className: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, className); if (found) return found; }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<Record<string, any>>;
  if (String(element.props.className ?? "").split(" ").includes(className)) return element;
  return find(element.props.children, className);
}

function fixture() {
  let readingRequest: unknown;
  const listeners = new Map<string, Set<() => void>>();
  const setting = { topK: 5, scoreThreshold: 0, chunkSize: 500, chunkOverlap: 100, pdfChunkPages: 6,
    embeddingBaseUrl: 'http://127.0.0.1:11434', embeddingApiKey: '',
    targetFolders: [], excludePatterns: [], searchFileExtensions: [], sourceRagSettings: [], externalIndexPath: "" };
  const plugin = {
    app: {}, settings: { cliConfig: {}, apiProviders: [], localLlmConfigs: [] }, workspaceState: { selectedRagSetting: "A" },
    getRagSettingNames: () => ["A", "B"], getRagSetting: () => setting, getRagSearchSetting: () => setting,
    syncVaultForLocalRAG: vi.fn() as (...args: any[]) => Promise<any>,
    settingsEmitter: {
      on: (name: string, callback: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); },
      off: (name: string, callback: () => void) => { listeners.get(name)?.delete(callback); },
    },
  };
  const send = vi.fn();
  function render() {
    let tree: ReturnType<typeof SearchPanel>;
    let iterations = 0;
    do {
      harness.dirty = false; harness.cursor = 0; harness.effects = [];
      tree = SearchPanel({ plugin: plugin as unknown as LlmHubPlugin, onChatWithResults: send, readingRequest } as Parameters<typeof SearchPanel>[0]);
      harness.effects.forEach(effect => effect());
      if (++iterations > 10) throw new Error("search panel did not settle");
    } while (harness.dirty);
    return tree!;
  }
  const emit = (name: string) => listeners.get(name)?.forEach(callback => callback());
  const unmount = () => harness.slots.forEach(slot => slot?.cleanup?.());
  return { plugin, send, render, emit, unmount, setReadingRequest: (request: unknown) => { readingRequest = request; } };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const chunk = (filePath: string) => ({ filePath, text: filePath, chunkIndex: 0, score: 0.9, contentType: "text" });

beforeEach(() => {
  harness.slots = []; harness.cursor = 0; harness.dirty = false; harness.effects = [];
  harness.notices = [];
  harness.search.mockReset(); harness.status.mockReset().mockResolvedValue({ chunkCount: 6 });
  harness.indexed.mockReset().mockResolvedValue([]); harness.pdf.mockReset(); harness.pdfText.mockReset();
  harness.sourceStatus.mockReset().mockResolvedValue("available"); vi.restoreAllMocks();
});

describe("search panel request ownership", () => {
  it("searches the right-click selection and inserts the chosen results into that same editor", async () => {
    const f = fixture();
    const editor = { getValue: () => "原笔记", replaceRange: vi.fn() };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: "阅读/笔记.md", file: view.file, selection: "选中文字", documentText: "原笔记", insertAt: { line: 0, ch: 3 }, editor, view };
    harness.search.mockResolvedValue([{ ...chunk("A/source.md"), text: "匹配正文" }]);
    f.setReadingRequest({ id: 1, context }); let tree = f.render(); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-query-input")!.props.value).toBe("选中文字");
    expect(harness.search).toHaveBeenCalledWith("A", "选中文字", expect.anything(), "", undefined, undefined, 5, f.plugin.settings);
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-reading-insert")!.props.onClick(); await flush();
    expect(editor.replaceRange).toHaveBeenCalledWith(expect.stringContaining("匹配正文"), { line: 0, ch: 3 });
  });

  it("does not insert when the target changes while the results are displayed", async () => {
    const f = fixture(); let document = "原笔记";
    const editor = { getValue: () => document, replaceRange: vi.fn() };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: view.file.path, file: view.file, selection: "关键词", documentText: document, insertAt: { line: 0, ch: 3 }, editor, view };
    harness.search.mockResolvedValue([{ ...chunk("A/source.md"), text: "匹配正文" }]);
    f.setReadingRequest({ id: 2, context }); let tree = f.render(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render(); document = "用户已编辑";
    find(tree, "llm-hub-reading-insert")!.props.onClick(); await flush();
    expect(editor.replaceRange).not.toHaveBeenCalled();
  });

  it("marks a source that disappears between searching and inserting its indexed excerpt", async () => {
    const f = fixture();
    const editor = { getValue: () => "原笔记", replaceRange: vi.fn() };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: view.file.path, file: view.file, selection: "关键词", documentText: "原笔记", insertAt: { line: 0, ch: 3 }, editor, view };
    harness.search.mockResolvedValue([{ ...chunk("A/source.md"), text: "索引中的正文" }]);
    harness.sourceStatus.mockResolvedValueOnce("available").mockResolvedValue("missing");
    f.setReadingRequest({ id: 3, context }); let tree = f.render(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-reading-insert")!.props.onClick(); await flush(); tree = f.render();
    expect(harness.sourceStatus).toHaveBeenCalledTimes(2);
    expect(find(tree, "llm-hub-search-source-missing")).toBeDefined();
    expect(editor.replaceRange).toHaveBeenCalledWith(expect.stringContaining("reading.sourceMissing"), { line: 0, ch: 3 });
  });

  it("does not insert a stale result after the user switches knowledge bases during source checking", async () => {
    const f = fixture();
    const editor = { getValue: () => "原笔记", replaceRange: vi.fn() };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: view.file.path, file: view.file, selection: "关键词", documentText: "原笔记", insertAt: { line: 0, ch: 3 }, editor, view };
    let finish!: (value: string) => void;
    harness.sourceStatus.mockResolvedValueOnce("available").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    harness.search.mockResolvedValue([chunk("A/source.md")]);
    f.setReadingRequest({ id: 4, context }); let tree = f.render(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-reading-insert")!.props.onClick();
    tree = f.render(); find(tree, "llm-hub-rag-select")!.props.onChange({ target: { value: "B" } }); tree = f.render();
    finish("available"); await flush();
    expect(editor.replaceRange).not.toHaveBeenCalled();
  });

  it("shows source checking and cancels the pending insert when the selection changes", async () => {
    const f = fixture(); const editor = { getValue: () => "原笔记", replaceRange: vi.fn() };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: view.file.path, file: view.file, selection: "关键词", documentText: "原笔记", insertAt: { line: 0, ch: 3 }, editor, view };
    let finish!: (value: string) => void;
    harness.sourceStatus.mockResolvedValueOnce("available").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    harness.search.mockResolvedValue([chunk("A/source.md")]); f.setReadingRequest({ id: 5, context });
    let tree = f.render(); await flush(); tree = f.render(); find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-reading-insert")!.props.onClick(); tree = f.render();
    expect(find(tree, "llm-hub-reading-insert")!.props.disabled).toBe(true);
    expect(find(tree, "llm-hub-reading-insert")!.props.children).toBe("reading.checkingSources");
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render(); finish("available"); await flush();
    expect(editor.replaceRange).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed insertion if the editor rejects the write", async () => {
    const f = fixture(); const editor = { getValue: () => "原笔记", replaceRange: vi.fn(() => { throw new Error("editor error"); }) };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: view.file.path, file: view.file, selection: "关键词", documentText: "原笔记", insertAt: { line: 0, ch: 3 }, editor, view };
    harness.search.mockResolvedValue([chunk("A/source.md")]); f.setReadingRequest({ id: 6, context });
    let tree = f.render(); await flush(); tree = f.render(); find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-reading-insert")!.props.onClick(); await flush();
    expect(harness.notices).toContain("reading.insertUnconfirmed");
    expect(harness.notices).not.toContain("reading.sourceCheckFailed");
  });

  it("rechecks the target after a slow source check and does not write into edited content", async () => {
    const f = fixture(); let document = "原笔记";
    const editor = { getValue: () => document, replaceRange: vi.fn() };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: view.file.path, file: view.file, selection: "关键词", documentText: document, insertAt: { line: 0, ch: 3 }, editor, view };
    let finish!: (value: string) => void;
    harness.sourceStatus.mockResolvedValueOnce("available").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    harness.search.mockResolvedValue([chunk("A/source.md")]); f.setReadingRequest({ id: 7, context });
    let tree = f.render(); await flush(); tree = f.render(); find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-reading-insert")!.props.onClick(); document = "用户在检查期间编辑"; finish("available"); await flush();
    expect(editor.replaceRange).not.toHaveBeenCalled();
    expect(harness.notices).toContain("reading.targetChanged");
  });

  it("inserts at most once when the insert handler is invoked twice before rendering", async () => {
    const f = fixture(); const editor = { getValue: () => "原笔记", replaceRange: vi.fn() };
    const view = { file: { path: "阅读/笔记.md" }, editor };
    (f.plugin.app as any).workspace = { getLeavesOfType: () => [{ view }] };
    (f.plugin.app as any).vault = { getAbstractFileByPath: () => view.file };
    const context = { filePath: view.file.path, file: view.file, selection: "关键词", documentText: "原笔记", insertAt: { line: 0, ch: 3 }, editor, view };
    harness.search.mockResolvedValue([chunk("A/source.md")]); f.setReadingRequest({ id: 8, context });
    let tree = f.render(); await flush(); tree = f.render(); find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    const click = find(tree, "llm-hub-reading-insert")!.props.onClick; click(); click(); await flush();
    expect(editor.replaceRange).toHaveBeenCalledOnce();
  });
  it("clears results and their selection when the user switches libraries", async () => {
    harness.search.mockResolvedValue([chunk("A/source.md")]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-rag-select")!.props.onChange({ target: { value: "B" } }); tree = f.render();
    expect(find(tree, "llm-hub-search-result-item")).toBeUndefined();
    expect(find(tree, "llm-hub-search-chat-btn")).toBeUndefined();
  });

  it("discards an A response that arrives after workspace selection and a B search", async () => {
    let resolveA!: (value: unknown[]) => void;
    harness.search.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
      .mockResolvedValueOnce([chunk("B/source.md")]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    f.plugin.workspaceState.selectedRagSetting = "B"; f.emit("workspace-state-loaded"); tree = f.render();
    find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-result-path")?.props.children).toBe("B/source.md");
    resolveA([chunk("A/source.md")]); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-result-path")?.props.children).toBe("B/source.md");
  });

  it("shows an error instead of an empty result after a search failure", async () => {
    harness.search.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce([chunk("A/retry.md")]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-error")).toBeDefined();
    expect(find(tree, "llm-hub-search-no-results")).toBeUndefined();
    find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-error")).toBeUndefined();
    expect(find(tree, "llm-hub-search-result-path")?.props.children).toBe("A/retry.md");
    expect(harness.search).toHaveBeenLastCalledWith("A", "term", expect.objectContaining({ topK: 5, scoreThreshold: 0 }),
      "", undefined, undefined, 5, f.plugin.settings);
  });

  it("marks missing sources and distinguishes semantic similarity from literal matches", async () => {
    harness.sourceStatus.mockResolvedValue("missing");
    harness.search.mockResolvedValue([{ ...chunk("A/missing.md"), text: "另一段知识" }]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "细胞" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-source-missing")?.props.children).toBe("search.sourceMissing");
    expect(find(tree, "llm-hub-search-match-reason")?.props.children).toBe("search.matchSemantic");
  });

  it("does not open a source that disappeared after the search completed", async () => {
    harness.sourceStatus.mockResolvedValueOnce("available").mockResolvedValueOnce("missing");
    harness.search.mockResolvedValue([chunk("A/source.md")]);
    const f = fixture(); const open = vi.fn();
    Object.assign(f.plugin.app, { vault: { getAbstractFileByPath: () => ({ path: "A/source.md" }) }, workspace: { openLinkText: open } });
    let tree = f.render(); find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-result-path")!.props.onClick({ stopPropagation() {} }); await flush();
    expect(open).not.toHaveBeenCalled();
  });

  it("shows a literal-match reason only for words present in the result", async () => {
    harness.search.mockResolvedValue([{ ...chunk("A/source.md"), text: "细胞膜控制物质进出" }]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "细胞膜" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    const reason = find(tree, "llm-hub-search-match-reason");
    expect(reason).toBeDefined();
    expect(reason?.props.children).toContain("细胞膜");
  });

  it("does not send A attachments if the user switches to B while they are being prepared", async () => {
    harness.search.mockResolvedValue([chunk("A/source.md")]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-search-chat-btn")!.props.onClick();
    find(tree, "llm-hub-rag-select")!.props.onChange({ target: { value: "B" } });
    await flush();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("sends selected results when the search still belongs to the active library", async () => {
    harness.search.mockResolvedValue([chunk("A/source.md")]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-result-item")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-search-chat-btn")!.props.onClick(); await flush();
    expect(f.send).toHaveBeenCalledWith([expect.objectContaining({ sourcePath: "A/source.md" })]);
  });

  it("does not create an old PDF preview after switching libraries", async () => {
    let resolvePdf!: (value: unknown) => void;
    harness.pdf.mockImplementation(() => new Promise(resolve => { resolvePdf = resolve; }));
    harness.search.mockResolvedValue([{ ...chunk("A/source.pdf"), contentType: "pdf", pageLabel: "pages 1-2" }]);
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old");
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    find(tree, "llm-hub-search-pdf-mode")!.props.onChange({ stopPropagation() {}, target: { value: "pdf" } });
    tree = f.render(); find(tree, "llm-hub-search-result-toggle")!.props.onClick({ stopPropagation() {} });
    tree = f.render(); find(tree, "llm-hub-rag-select")!.props.onChange({ target: { value: "B" } });
    resolvePdf({ data: btoa("synthetic") }); await flush();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("ignores a response after the search panel is closed", async () => {
    let resolveSearch!: (value: unknown[]) => void;
    harness.search.mockImplementation(() => new Promise(resolve => { resolveSearch = resolve; }));
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); f.render();
    f.unmount(); harness.dirty = false;
    resolveSearch([chunk("A/source.md")]); await flush();
    expect(harness.dirty).toBe(false);
  });

  it("keeps the indexed file list attributed to the library that returned it", async () => {
    let resolveA!: (value: unknown[]) => void;
    harness.indexed.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
      .mockResolvedValueOnce([{ filePath: "B/indexed.md", chunks: 1 }]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-rag-icon-btn")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-rag-indexed-files-toggle")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-rag-select")!.props.onChange({ target: { value: "B" } }); tree = f.render();
    await flush(); tree = f.render();
    expect(find(tree, "llm-hub-rag-indexed-file-path")?.props.children).toBe("B/indexed.md");
    resolveA([{ filePath: "A/indexed.md", chunks: 1 }]); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-rag-indexed-file-path")?.props.children).toBe("B/indexed.md");
  });

  it("cancels the same managed sync task immediately without waiting for progress", async () => {
    const tasks = new TaskManager();
    const f = fixture();
    f.plugin.syncVaultForLocalRAG = vi.fn((_name, _progress, signal: AbortSignal) => tasks.run("index", async task =>
      new Promise<void>((_resolve, reject) => task.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })))), { signal, serial: true }));
    let tree = f.render();
    find(tree, "llm-hub-rag-icon-btn")!.props.onClick(); tree = f.render();
    find(tree, "llm-hub-rag-text-btn")!.props.onClick(); await flush(); tree = f.render();
    const signal = vi.mocked(f.plugin.syncVaultForLocalRAG).mock.calls[0][2] as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    find(tree, "llm-hub-rag-text-btn")!.props.onClick(); await flush();
    expect(signal?.aborted).toBe(true);
    expect(tasks.list()[0].snapshot.status).toBe("cancelled");
  });

  it("does not let delayed PDF text from A suppress PDF extraction in B", async () => {
    let resolveText!: (value: string) => void;
    harness.pdfText.mockImplementationOnce(() => new Promise(resolve => { resolveText = resolve; })).mockResolvedValue("B extracted");
    harness.search.mockResolvedValueOnce([{ ...chunk("A/a.pdf"), text: "[Pdf: A]", contentType: "pdf" }])
      .mockResolvedValueOnce([{ ...chunk("B/b.pdf"), text: "[Pdf: B]", contentType: "pdf" }]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    find(tree, "llm-hub-rag-select")!.props.onChange({ target: { value: "B" } });
    resolveText("A extracted"); await flush();
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render(); await flush(); tree = f.render();
    expect(harness.pdfText).toHaveBeenCalledTimes(2);
    expect(find(tree, "llm-hub-search-result-preview")?.props.children).toBe("B extracted");
  });

  it("distinguishes an empty index from a ready index with no matches", async () => {
    harness.status.mockResolvedValueOnce({ chunkCount: 0 }).mockResolvedValue({ chunkCount: 6 });
    harness.search.mockResolvedValue([]);
    const f = fixture(); let tree = f.render();
    find(tree, "llm-hub-search-query-input")!.props.onChange({ target: { value: "term" } });
    tree = f.render(); find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-not-ready")).toBeDefined();
    expect(harness.search).not.toHaveBeenCalled();
    find(tree, "llm-hub-search-btn")!.props.onClick(); await flush(); tree = f.render();
    expect(find(tree, "llm-hub-search-no-results")).toBeDefined();
  });
});
