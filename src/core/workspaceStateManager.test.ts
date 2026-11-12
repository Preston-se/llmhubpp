import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { LlmHubSettings } from "../types";
import { EventEmitter } from "../utils/EventEmitter";
import { WorkspaceStateManager } from "./workspaceStateManager";
import { memoryVault } from "./testSupport/memoryVault";
import { configureRagStorageDirectory, createEmptyIndex, loadRagSnapshot, saveRagSnapshot } from "./localRagStorage";
import { DEFAULT_SETTINGS, DEFAULT_RAG_SETTING } from "../types";

function isolatedManager() {
  const m = memoryVault();
  const settings = { ...DEFAULT_SETTINGS, workspaceFolder: "OwnedRoot", storageLayout: { version: 1 as const, root: "OwnedRoot", overrides: { state: "Config", rag: "Indexes" } } };
  configureRagStorageDirectory("OwnedRoot", "Indexes");
  const manager = new WorkspaceStateManager(m.app, () => settings, new EventEmitter(), async () => ({}));
  return { ...m, settings, manager };
}

describe("source collection ownership and independent storage", () => {
  it("rejects source names which alias ordinary indexes, including Windows case aliases", async () => {
    for (const [ordinary, source] of [["A B", "A_B"], ["Books", "books"]]) {
      const m = isolatedManager(); await m.manager.createRagSetting(ordinary);
      await saveRagSnapshot(m.app, ordinary, createEmptyIndex(), new Float32Array(), "OwnedRoot");
      const before = [...m.files];
      await expect(m.manager.ensureSourceRagSetting(source, "owner-1", false)).rejects.toMatchObject({ code: "index-conflict" });
      expect([...m.files]).toEqual(before);
      expect(m.manager.workspaceState.ragSettings[source]).toBeUndefined();
    }
  });
  it("requires a matching manifest for an existing source-owned setting and rejects orphan index storage", async () => {
    const m = isolatedManager();
    await m.manager.ensureSourceRagSetting("Converted", "owner-1", false);
    await expect(m.manager.ensureSourceRagSetting("Converted", "owner-1", true)).resolves.toBeUndefined();
    await expect(m.manager.ensureSourceRagSetting("Converted", "owner-1", false)).rejects.toMatchObject({ code: "index-conflict" });
    await expect(m.manager.ensureSourceRagSetting("Converted", "owner-2", true)).rejects.toMatchObject({ code: "index-conflict" });
    await saveRagSnapshot(m.app, "Orphan", createEmptyIndex(), new Float32Array(), "OwnedRoot");
    await expect(m.manager.ensureSourceRagSetting("Orphan", "owner-3", false)).rejects.toMatchObject({ code: "index-conflict" });
  });
  it("routes ordinary rename and delete to configured index storage rather than independent state storage", async () => {
    const m = isolatedManager(); await m.manager.createRagSetting("Old");
    const index = { ...createEmptyIndex(), embeddingModel: "test", dimension: 2, meta: [{ filePath: "a.md", chunkIndex: 0, text: "preserved" }], fileChecksums: { "a.md": "hash" } };
    await saveRagSnapshot(m.app, "Old", index, new Float32Array([1, 0]), "OwnedRoot");
    m.files.set("Config/rag/Old/unrelated.txt", "keep");
    await m.manager.renameRagSetting("Old", "New");
    expect((await loadRagSnapshot(m.app, "New", "OwnedRoot"))?.index.meta[0].text).toBe("preserved");
    expect(await loadRagSnapshot(m.app, "Old", "OwnedRoot")).toBeNull();
    await m.manager.deleteRagSetting("New");
    expect(await loadRagSnapshot(m.app, "New", "OwnedRoot")).toBeNull();
    expect(m.files.get("Config/rag/Old/unrelated.txt")).toBe("keep");
    expect(m.files.has("Config/gemini-workspace.json")).toBe(true);
  });
  it("keeps source ownership immutable while permitting embedding and retrieval changes", async () => {
    const m = isolatedManager();
    await m.manager.createRagSetting("Converted", { ...DEFAULT_RAG_SETTING, sourceCollection: true });
    const before = [...m.files];
    await expect(m.manager.renameRagSetting("Converted", "Books")).rejects.toThrow();
    await expect(m.manager.updateRagSetting("Converted", { externalIndexPath: "External" })).rejects.toThrow();
    await expect(m.manager.updateRagSetting("Converted", { sourceRagSettings: ["Other"] })).rejects.toThrow();
    await expect(m.manager.updateRagSetting("Converted", { sourceCollection: false })).rejects.toThrow();
    expect([...m.files]).toEqual(before);
    await m.manager.updateRagSetting("Converted", { embeddingModel: "new-model", topK: 9 });
    expect(m.manager.getRagSetting("Converted")).toMatchObject({ embeddingModel: "new-model", topK: 9, sourceCollection: true });
  });
});

function createManager(initialContent: string) {
  let content = initialContent;
  const write = vi.fn(async (_path: string, value: string) => { content = value; });
  const adapter = {
    exists: vi.fn(async (path: string) => path === "LLMHub/gemini-workspace.json" || path === "LLMHub"),
    read: vi.fn(async () => content),
    write,
    mkdir: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  const emitter = new EventEmitter();
  const manager = new WorkspaceStateManager(
    { vault: { adapter } } as unknown as App,
    () => ({ workspaceFolder: "LLMHub", apiProviders: [], cliConfig: {} } as unknown as LlmHubSettings),
    emitter,
    async () => ({}),
  );
  return { manager, emitter, write, adapter, getContent: () => content };
}

describe("WorkspaceStateManager combined search persistence", () => {
  it.each([
    "gemini-3-flash-preview",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-2.5-flash",
  ])("migrates superseded Gemini Flash model %s", async (legacyModel) => {
    const harness = createManager(JSON.stringify({
      selectedModel: `api:gemini:${legacyModel}`,
      ragSettings: {},
    }));

    await harness.manager.loadWorkspaceState();

    expect(harness.manager.workspaceState.selectedModel).toBe("api:gemini:gemini-3.8-flash");
  });

  it("migrates retired Gemini 2.5 Pro", async () => {
    const harness = createManager(JSON.stringify({
      selectedModel: "api:gemini:gemini-2.5-pro",
      ragSettings: {},
    }));

    await harness.manager.loadWorkspaceState();

    expect(harness.manager.workspaceState.selectedModel).toBe("api:gemini:gemini-3.1-pro-preview");
  });

  it.each([
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
  ])("migrates deprecated Gemini Flash Lite model %s", async (legacyModel) => {
    const harness = createManager(JSON.stringify({
      selectedModel: `api:gemini:${legacyModel}`,
      ragSettings: {},
    }));

    await harness.manager.loadWorkspaceState();

    expect(harness.manager.workspaceState.selectedModel).toBe("api:gemini:gemini-3.5-flash-lite");
  });

  it("migrates and rewrites the legacy Web-only sentinel", async () => {
    const harness = createManager(JSON.stringify({
      selectedRagSetting: "__websearch__",
      ragSettings: {},
    }));

    await harness.manager.loadWorkspaceState();

    expect(harness.manager.workspaceState.selectedRagSetting).toBeNull();
    expect(harness.manager.workspaceState.webSearchEnabled).toBe(true);
    expect(harness.write).toHaveBeenCalledOnce();
    expect(JSON.parse(harness.getContent())).toMatchObject({
      selectedRagSetting: null,
      webSearchEnabled: true,
    });
  });

  it("saves Web and RAG atomically and emits the combined selection", async () => {
    const harness = createManager(JSON.stringify({ ragSettings: {} }));
    const listener = vi.fn();
    harness.emitter.on("search-selection-changed", listener);

    await harness.manager.loadWorkspaceState();
    await harness.manager.selectSearchSelection({ webSearch: true, ragSetting: "Research" });

    expect(JSON.parse(harness.getContent())).toMatchObject({
      selectedRagSetting: "Research",
      webSearchEnabled: true,
    });
    expect(listener).toHaveBeenCalledWith({ webSearch: true, ragSetting: "Research" });
  });
});

describe("WorkspaceStateManager RAG setting names and their index", () => {
  const setting = (overrides: Record<string, unknown> = {}) => ({
    embeddingBaseUrl: "", embeddingApiKey: "", embeddingModel: "", chunkSize: 500, chunkOverlap: 100,
    pdfChunkPages: 6, topK: 5, scoreThreshold: 0.3, targetFolders: [], excludePatterns: [],
    searchFileExtensions: [], lastFullSync: null, externalIndexPath: "", sourceRagSettings: [],
    indexMultimodal: false, ...overrides,
  });

  it("refuses a name whose index directory an existing setting already owns", async () => {
    // Both reduce to "My_Index": one directory, two settings writing vectors to it.
    const harness = createManager(JSON.stringify({ ragSettings: { "My Index": setting() } }));
    await harness.manager.loadWorkspaceState();

    await expect(harness.manager.createRagSetting("My/Index")).rejects.toThrow(/conflicts/);
    await expect(harness.manager.renameRagSetting("My Index", "My.Index")).resolves.toBeUndefined();
  });

  it("moves the index with the setting when it is renamed", async () => {
    const harness = createManager(JSON.stringify({
      selectedRagSetting: "Old",
      ragSettings: { Old: setting(), Bundle: setting({ sourceRagSettings: ["Old"] }) },
    }));
    await harness.manager.loadWorkspaceState();

    await harness.manager.renameRagSetting("Old", "New");

    // The rename reads the old index before writing the new one; leaving it
    // behind meant the renamed setting re-embedded the whole vault.
    expect(harness.adapter.exists).toHaveBeenCalledWith("LLMHub/rag/Old");
    expect(harness.manager.workspaceState.ragSettings.Bundle.sourceRagSettings).toEqual(["New"]);
    expect(harness.manager.workspaceState.selectedRagSetting).toBe("New");
  });

  it("removes the index when the setting is deleted", async () => {
    const harness = createManager(JSON.stringify({
      selectedRagSetting: "Gone",
      ragSettings: { Gone: setting(), Bundle: setting({ sourceRagSettings: ["Gone", "Kept"] }), Kept: setting() },
    }));
    await harness.manager.loadWorkspaceState();

    await harness.manager.deleteRagSetting("Gone");

    expect(harness.adapter.exists).toHaveBeenCalledWith("LLMHub/rag/Gone/index.json");
    expect(harness.manager.workspaceState.ragSettings.Gone).toBeUndefined();
    expect(harness.manager.workspaceState.ragSettings.Bundle.sourceRagSettings).toEqual(["Kept"]);
    expect(harness.manager.workspaceState.selectedRagSetting).toBeNull();
  });
});
