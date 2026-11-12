import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { memoryVault } from "./testSupport/memoryVault";
vi.mock("./embeddingProvider", () => ({ generateEmbeddings: async (texts: string[]) => texts.map(() => [1, 0]),
  generateGeminiNativeEmbeddings: vi.fn(), MULTIMODAL_EXTENSIONS: new Set(), MULTIMODAL_FILE_SIZE_LIMITS: {} }));
import { initLocalRagStore, resetLocalRagStore } from "./localRagStore";
import { loadRagSnapshot } from "./localRagStorage";

it("indexes only the verified conversion collection without changing another knowledge base", async () => {
  const m = memoryVault(); const files = ["原资料.md", "附件/_llmhub_generated/课/v1/课.ai.md", "附件/_llmhub_generated/课/v0/旧.ai.md"].map(path => Object.assign(new TFile(), { path, extension: "md" }));
  files.forEach((f, i) => m.files.set(f.path, ["用户知识库内容", "新转换正文", "旧版本正文"][i]));
  m.files.set(files[1].path, '---\nllmhubpp_source: true\nsource_path: "课程/原书.pdf"\nsource_page: "pages 2-3 of 9"\n---\n新转换正文');
  const app = m.app as any; app.vault.getFiles = () => files; app.vault.read = async (file: TFile) => m.files.get(file.path);
  resetLocalRagStore(); const store = initLocalRagStore();
  await store.sync(app, "普通库", "", "mock", 500, 0, 6, { includeFolders: [], excludePatterns: [] }, undefined, "http://localhost:1");
  const before = [...m.files].filter(([p]) => p.startsWith("LLMHub/rag/普通库/"));
  await store.sync(app, "转换库", "", "mock", 500, 0, 6, { includeFolders: [], excludePatterns: [], filePaths: [files[1].path] }, undefined, "http://localhost:1");
  const snapshot = await loadRagSnapshot(app, "转换库", "LLMHub");
  expect(snapshot?.index.meta.map(chunk => chunk.filePath)).toEqual([files[1].path]);
  expect(snapshot?.index.meta[0]).toMatchObject({ originalFilePath: "课程/原书.pdf", pageLabel: "pages 2-3 of 9" });
  expect([...m.files].filter(([p]) => p.startsWith("LLMHub/rag/普通库/"))).toEqual(before);
});
