import { describe, expect, it } from "vitest";
import { resolveStoragePaths, createStorageLayout, isManagedRootExport } from "./storagePaths";
import { memoryVault } from "./testSupport/memoryVault";
import { writeChatNote } from "obsidian-llm-hub-common/chat";

describe("storage path compatibility", () => {
  it("recognizes actual legacy root chat exports without excluding ordinary root notes", async () => {
    const m = memoryVault(); const paths = resolveStoragePaths({}, m.app.vault.configDir);
    const output = await writeChatNote({ app: m.app, getManualChatSaveFolder: () => "" } as never,
      [{ role: "user", content: "练习", timestamp: 1 }]);
    expect(await isManagedRootExport(m.io as never, paths, output)).toBe(true);
    m.files.set("20261106-123456_阅读.md", "# 我的阅读资料");
    expect(await isManagedRootExport(m.io as never, paths, "20261106-123456_阅读.md")).toBe(false);
    expect(await isManagedRootExport(m.io as never, paths, "阅读.md")).toBe(false);
  });
  it("inherits new-install folders from the root and keeps separately overridden folders", () => {
    expect(resolveStoragePaths(null)).toMatchObject({ workspace: "LLMHub", tools: "LLMHub/tools", skills: "LLMHub/skills", rag: "LLMHub/rag", chats: "LLMHub", exports: "LLMHub" });
    const layout = createStorageLayout(null); layout.root = "资料/助手"; layout.overrides.skills = "自定义/技能";
    expect(resolveStoragePaths({ storageLayout: layout })).toMatchObject({ workspace: "资料/助手", skills: "自定义/技能", tools: "资料/助手/tools", rag: "资料/助手/rag" });
  });
  it("keeps empty saved legacy settings and omitted defaults on their original paths after round trip", () => {
    for (const saved of [{}, { workspaceFolder: "" }, { workspaceFolder: "旧工作区", skillsFolder: "其他技能", manualChatSaveFolder: "导出" }]) {
      const before = resolveStoragePaths(saved);
      const layout = createStorageLayout(saved); layout.root = "新根目录";
      const after = resolveStoragePaths(JSON.parse(JSON.stringify({ ...saved, storageLayout: layout })));
      expect(after.skills).toBe(before.skills); expect(after.rag).toBe(before.rag); expect(after.chats).toBe(before.chats);
      expect(after.exports).toBe(before.exports); expect(after.state).toBe(before.state);
    }
    expect(resolveStoragePaths({}, ".obsidian")).toMatchObject({ skills: "skills", exports: "", rag: "LLMHub/rag", tasks: ".obsidian/llmhubpp-task-journal" });
  });
  it.each(["../外部", "C:/资料", "/绝对", "资料/../外部"])("rejects invalid path %s without changing saved settings", path => {
    const layout = createStorageLayout(null); layout.overrides.rag = path;
    expect(() => resolveStoragePaths({ storageLayout: layout })).toThrow();
  });
});
