import { describe, expect, it } from "vitest";
import { memoryVault } from "./testSupport/memoryVault";
import { TaskManager } from "./taskManager";
import { TaskJournal } from "./taskJournal";
import { DEFAULT_SOURCE_WATCH, matchSourceDirectory } from "./sourceWatchPolicy";
import { SourceIngestCoordinator } from "./sourceIngestCoordinator";
import { getStoragePaths } from "./storagePaths";
import { EventEmitter } from "../utils/EventEmitter";
import { WorkspaceStateManager } from "./workspaceStateManager";
import { DEFAULT_SETTINGS } from "../types";

describe("source watch and safe publication", () => {
  it("never syncs an older source list after the latest committed manifest is damaged", async () => {
    const m = memoryVault(); const app = m.app as any;
    app.vault.create = async (path: string, content: string) => { m.files.set(path, content); return { path }; };
    const lists: string[][] = [];
    const host = { app, tasks: new TaskManager(), policy: () => ({ ...DEFAULT_SOURCE_WATCH, enabled: true }), workspace: () => "LLMHub",
      ensureIndex: async () => undefined, sync: async (_name: string, paths: string[]) => { lists.push(paths); } };
    const service = new SourceIngestCoordinator(host, { stableDelayMs: 0 });
    for (const name of ["A", "B"]) { m.files.set(`${name}.txt`, name); await service.enqueue(`${name}.txt`); }
    expect(lists.at(-1)).toHaveLength(2);
    const latest = [...m.files.keys()].filter(path => /manifest-\d+\.json$/.test(path)).sort().at(-1)!;
    m.files.set(latest, "damaged"); m.files.set("C.txt", "C");
    await expect(new SourceIngestCoordinator(host, { stableDelayMs: 0 }).enqueue("C.txt")).rejects.toMatchObject({ code: "manifest-invalid" });
    expect(lists).toHaveLength(2); expect(lists.at(-1)).toHaveLength(2);
  });
  it("preserves an existing collection when its manifest location is switched or missing", async () => {
    const m = memoryVault(); const app = m.app as any;
    app.vault.create = async (path: string, content: string) => { m.files.set(path, content); return { path }; };
    const manager = new WorkspaceStateManager(app, () => DEFAULT_SETTINGS, new EventEmitter(), async () => ({}));
    const lists: string[][] = [];
    const host = { app, tasks: new TaskManager(), policy: () => ({ ...DEFAULT_SOURCE_WATCH, enabled: true }), workspace: () => "LLMHub",
      ensureIndex: (name: string, owner: string, exists: boolean) => manager.ensureSourceRagSetting(name, owner, exists),
      sync: async (_name: string, paths: string[]) => { lists.push(paths); } };
    m.files.set("A.txt", "A"); await new SourceIngestCoordinator(host, { stableDelayMs: 0 }).enqueue("A.txt");
    const before = [...m.files]; m.files.set("B.txt", "B");
    const switched = new SourceIngestCoordinator({ ...host, manifestDirectory: "NewManifestLocation" }, { stableDelayMs: 0 });
    await expect(switched.enqueue("B.txt")).rejects.toMatchObject({ code: "index-conflict" });
    expect(lists).toHaveLength(1); expect([...m.files]).toEqual([...before, ["B.txt", "B"]]);
  });
  it("excludes all effective managed folders during events, resume, and scan without excluding the vault root", async () => {
    const m = memoryVault(); const app = m.app as any;
    const paths = getStoragePaths({ storageLayout: { version: 1, root: "LLMHub", overrides: { chats: "ChatHistory", tools: "Tools", exports: "Exports", skills: "Skills" } } }, app.vault.configDir);
    const managed = Object.values(paths);
    const sources = ["ChatHistory/a.md", "Tools/a.md", "Exports/a.md", "Skills/a.md", "LLMHub/a.md", "TestConfig/a.md"];
    sources.forEach(path => m.files.set(path, "generated")); m.files.set("Reading/book.txt", "book");
    app.vault.getFiles = () => [...m.files.keys()].map(path => ({ path }));
    app.vault.create = async (path: string, text: string) => { m.files.set(path, text); return { path }; };
    const indexed: string[][] = []; const tasks = new TaskManager();
    const policy = { ...DEFAULT_SOURCE_WATCH, enabled: true };
    const service = new SourceIngestCoordinator({ app, tasks, policy: () => policy, workspace: () => paths.workspace,
      managedDirectories: () => managed, ensureIndex: async () => undefined, sync: async (_name, list) => { indexed.push(list); } }, { stableDelayMs: 0 });
    for (const path of sources) await service.enqueue(path);
    expect(tasks.list()).toHaveLength(0);
    await service.scan(); expect(indexed).toHaveLength(1); expect(indexed[0][0]).toContain("book");
    expect(matchSourceDirectory("Reading/book.txt", policy, "LLMHub", "TestConfig", [""])).toBe(true);
    expect(matchSourceDirectory("ChatHistory2/book.txt", policy, "LLMHub", "TestConfig", managed)).toBe(true);
  });
  it("keeps a conversion paused after restart until the user resumes it", async () => {
    const m = memoryVault(); m.files.set("课程.txt", "可恢复资料");
    const app = m.app as any;
    app.vault.create = async (path: string, content: string) => { if (m.files.has(path)) throw new Error("exists"); m.files.set(path, content); return { path }; };
    const tasks = new TaskManager(); const journal = new TaskJournal(m.io as never, "日志");
    await tasks.initialize(journal, async () => { throw new Error("must use new runtime"); });
    const host = { app, tasks, policy: () => ({ ...DEFAULT_SOURCE_WATCH, enabled: true }), workspace: () => "LLMHub", ensureIndex: async () => undefined, sync: async () => undefined };
    const service = new SourceIngestCoordinator(host, { stableDelayMs: 0 });
    const pending = service.enqueue("课程.txt").catch(() => undefined);
    await tasks.suspendAll(); await pending;
    expect([...m.files.keys()].some(path => path.endsWith(".ai.md"))).toBe(false);
    const next = new TaskManager(); const nextService = new SourceIngestCoordinator({ ...host, tasks: next }, { stableDelayMs: 0 });
    await next.initialize(new TaskJournal(m.io as never, "日志"), (descriptor, task) => nextService.resume(descriptor.source!, task));
    expect(next.list()[0].snapshot.status).toBe("paused");
    const completed = new Promise<void>((resolve, reject) => {
      const off = next.subscribe(() => {
        const status = next.list()[0].snapshot.status;
        if (status === "completed") { off(); resolve(); }
        if (status === "failed") { off(); reject(new Error(next.list()[0].snapshot.error)); }
      });
    });
    next.list()[0].resume(); await completed;
    expect([...m.files.keys()].some(path => path.endsWith(".ai.md"))).toBe(true);
  });
  it("keeps published text when embedding fails and retries indexing without duplicate output", async () => {
    const m = memoryVault(); m.files.set("课.txt", "课程正文"); const app = m.app as any;
    app.vault.create = async (path: string, content: string) => { if (m.files.has(path)) throw new Error("exists"); m.files.set(path, content); return { path }; };
    let failing = true; const tasks = new TaskManager();
    const service = new SourceIngestCoordinator({ app, tasks, policy: () => ({ ...DEFAULT_SOURCE_WATCH, enabled: true }), workspace: () => "LLMHub",
      ensureIndex: async () => undefined, sync: async () => { if (failing) throw Object.assign(new Error("embedding unavailable"), { code: "embedding-missing" }); } }, { stableDelayMs: 0 });
    await expect(service.enqueue("课.txt")).rejects.toThrow();
    const outputs = [...m.files.keys()].filter(path => path.endsWith(".ai.md"));
    expect(outputs).toHaveLength(1); expect(tasks.list()[0].snapshot.status).toBe("failed");
    failing = false; await service.enqueue("课.txt");
    expect([...m.files.keys()].filter(path => path.endsWith(".ai.md"))).toEqual(outputs);
    expect(tasks.list().at(-1)?.snapshot.status).toBe("completed");
  });
  it("matches directory regexes in both modes and rejects invalid expressions and generated paths", () => {
    const base = { ...DEFAULT_SOURCE_WATCH, enabled: true, folderPatterns: ["^课程(?:/|$)"] };
    expect(matchSourceDirectory("课程/原书.epub", base, "LLMHub")).toBe(true);
    expect(matchSourceDirectory("其他/原书.epub", base, "LLMHub")).toBe(false);
    expect(matchSourceDirectory("其他/原书.epub", { ...base, mode: "exclude" }, "LLMHub")).toBe(true);
    expect(matchSourceDirectory("课程/附件/_llmhub_generated/原书/x.md", { ...base, mode: "exclude", folderPatterns: [] }, "LLMHub")).toBe(false);
    expect(matchSourceDirectory("LLMHub/工具.txt", { ...base, folderPatterns: [] }, "LLMHub")).toBe(false);
    expect(() => matchSourceDirectory("课程/a.txt", { ...base, folderPatterns: ["["] }, "LLMHub")).toThrow();
  });
  it("publishes source-side linked Markdown, deduplicates events, and never overwrites an edited output", async () => {
    const m = memoryVault(); m.files.set("课程/原书.txt", "原始教程正文");
    const config = { ...DEFAULT_SOURCE_WATCH, enabled: true };
    const indexed: string[][] = [];
    const app = m.app as any;
    app.vault.create = async (path: string, content: string) => { if (m.files.has(path)) throw new Error("exists"); m.files.set(path, content); return { path }; };
    app.vault.createBinary = async (path: string, content: ArrayBuffer) => { if (m.files.has(path)) throw new Error("exists"); m.files.set(path, content); return { path }; };
    const service = new SourceIngestCoordinator({ app, tasks: new TaskManager(), policy: () => config, workspace: () => "LLMHub",
      ensureIndex: async () => undefined, sync: async (_name, paths) => { indexed.push(paths); } }, { stableDelayMs: 0 });
    const a = service.enqueue("课程/原书.txt"), b = service.enqueue("课程/原书.txt");
    await Promise.all([a, b]);
    let docs = [...m.files.keys()].filter(p => p.includes("_llmhub_generated") && p.endsWith(".ai.md"));
    expect(docs).toHaveLength(1); expect(docs[0]).toContain("课程/附件/");
    expect(m.files.get(docs[0])).toContain("[[课程/原书.txt]]");
    expect(m.files.get(docs[0])).toContain("原始教程正文"); expect(indexed.at(-1)).toEqual(docs);
    const original = docs[0]; m.files.set(original, "用户修改保留");
    await service.enqueue("课程/原书.txt");
    docs = [...m.files.keys()].filter(p => p.endsWith(".ai.md"));
    expect(docs).toHaveLength(2); expect(m.files.get(original)).toBe("用户修改保留");
    expect(m.files.get("课程/原书.txt")).toBe("原始教程正文");
    expect(indexed.at(-1)).toHaveLength(1); expect(indexed.at(-1)).not.toContain(original);
  });
  it("stops on a corrupted manifest instead of indexing an empty collection", async () => {
    const m = memoryVault(); m.files.set("a.txt", "原文"); m.files.set(`${m.app.vault.configDir}/llmhubpp-sources/manifest-00000000000000000001.json`, "invalid");
    let synced = false;
    const service = new SourceIngestCoordinator({ app: m.app, tasks: new TaskManager(), policy: () => ({ ...DEFAULT_SOURCE_WATCH, enabled: true }),
      workspace: () => "LLMHub", ensureIndex: async () => undefined, sync: async () => { synced = true; } }, { stableDelayMs: 0 });
    await expect(service.enqueue("a.txt")).rejects.toThrow(); expect(synced).toBe(false);
  });
});
