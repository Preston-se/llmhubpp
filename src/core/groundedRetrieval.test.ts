import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { memoryVault } from "./testSupport/memoryVault";
import { saveRagSnapshot, ragEmbeddingFingerprint, type LocalRagIndex } from "./localRagStorage";
import { DEFAULT_RAG_SETTING } from "src/types";

const stub = vi.hoisted(() => ({ embed: vi.fn(), jev: vi.fn() }));
vi.mock("./embeddingProvider", () => ({
  generateEmbeddings: (...args: any[]) => stub.embed(...args), generateGeminiNativeEmbeddings: vi.fn(),
  MULTIMODAL_EXTENSIONS: new Set(), MULTIMODAL_FILE_SIZE_LIMITS: {},
}));
vi.mock("./jevRagFilter", () => ({ filterRagResultsWithJev: stub.jev, getOpenRouterApiKey: () => "" }));
import * as localRag from "./localRagStore";

const setting = { ...DEFAULT_RAG_SETTING, embeddingBaseUrl: "http://127.0.0.1:1", embeddingApiKey: "", embeddingModel: "mock",
  topK: 6, scoreThreshold: 0, searchFileExtensions: [] as string[] };
const settings = { apiProviders: [], jevRagFilterEnabled: false, jevApiKey: "", jevUseOpenRouter: false };
const retrieve = (input: unknown): Promise<any> | undefined => (localRag as unknown as {
  retrieveGroundedContext?: (request: unknown) => Promise<any>;
}).retrieveGroundedContext?.(input);

async function fixture(count = 6, verified = true) {
  const vault = memoryVault();
  const known = new Set(Array.from({ length: Math.max(0, count - 1) }, (_, i) => `A/${i}.md`));
  (vault.app.vault as any).getAbstractFileByPath = (path: string) => known.has(path) ? Object.assign(new TFile(), { path }) : null;
  const meta = Array.from({ length: count }, (_, i) => ({ filePath: `A/${i}.md`, chunkIndex: 0, text: `合成资料 ${i}` }));
  const index: LocalRagIndex = { meta, dimension: 2, fileChecksums: {}, embeddingModel: "mock", ...(verified?{embeddingSpace: await ragEmbeddingFingerprint('mock',setting.embeddingBaseUrl)}:{}), chunkSize: 500, chunkOverlap: 100 };
  if (count) await saveRagSnapshot(vault.app, "A", index, new Float32Array(meta.flatMap(() => [1, 0])), "LLMHub");
  localRag.resetLocalRagStore(); const store = localRag.initLocalRagStore(); await store.load(vault.app, ["A"]);
  return { vault, request: { app: vault.app, settingName: "A", query: "合成", setting, settings, fallbackApiKey: "" } };
}

beforeEach(() => { localRag.resetLocalRagStore(); stub.embed.mockReset().mockResolvedValue([[1, 0]]); stub.jev.mockReset(); });

describe("grounded retrieval", () => {
  it.each(['unverified','changed'])('exposes a %s vector space before requesting query embeddings',async kind=>{
    const {vault,request}=await fixture(2,kind!=='unverified');const before=new Map(vault.files);
    const result=await retrieve(kind==='changed'?{...request,setting:{...setting,embeddingBaseUrl:'http://different'}}:request);
    expect(result).toMatchObject({status:'not-ready',reason:`vector-space-${kind}`});expect(stub.embed).not.toHaveBeenCalled();expect(vault.files).toEqual(before);
  });
  it("uses real index results, preserves Top K and marks a missing source without inventing one", async () => {
    const { request } = await fixture();
    const result = await retrieve(request);
    expect(result).toMatchObject({ status: "success", settingName: "A", query: "合成" });
    expect(result.results).toHaveLength(6);
    expect(result.results[0]).toMatchObject({ filePath: "A/0.md", text: "合成资料 0", sourceStatus: "available" });
    expect(result.results[5]).toMatchObject({ filePath: "A/5.md", text: "合成资料 5", sourceStatus: "missing" });
  });

  it("distinguishes an empty index, no matching chunks, and missing embedding configuration", async () => {
    const empty = await fixture(0);
    expect(await retrieve(empty.request)).toMatchObject({ status: "not-ready", reason: "index-empty" });
    const ready = await fixture();
    expect(await retrieve({ ...ready.request, setting: { ...setting, searchFileExtensions: ["pdf"] } })).toMatchObject({ status: "empty" });
    expect(await retrieve({ ...ready.request, setting: { ...setting, embeddingBaseUrl: "", embeddingApiKey: "" } })).toMatchObject({ status: "not-ready", reason: "embedding-missing" });
  });

  it("reports embedding errors or incompatible vector dimensions as failures, not no matches", async () => {
    const { request } = await fixture();
    stub.embed.mockRejectedValueOnce(new Error("503 secret"));
    expect(await retrieve(request)).toMatchObject({ status: "error", reason: "embedding-unavailable" });
    stub.embed.mockResolvedValueOnce([[1, 2, 3]]);
    expect(await retrieve(request)).toMatchObject({ status: "error", reason: "embedding-unavailable" });
  });

  it("returns cancelled and stops the supported embedding request when the caller aborts", async () => {
    const { request } = await fixture(); const controller = new AbortController(); let sawAbort = false;
    let entered!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;});
    stub.embed.mockImplementation((_texts, _key, _model, _base, _proxy, _bypass, control) => new Promise((_resolve, reject) => {
      control?.signal.addEventListener("abort", () => { sawAbort = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      entered();
    }));
    const pending = retrieve({ ...request, signal: controller.signal });
    await active; controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(sawAbort).toBe(true);
  });

  it("searches a merged index using the existing source-index configuration", async () => {
    const { vault, request } = await fixture(1);
    vault.app.vault.getAbstractFileByPath = (path: string) => ['A/0.md','B/other.md'].includes(path) ? Object.assign(new TFile(),{path}) : null;
    const b: LocalRagIndex = { meta: [{ filePath: "B/other.md", chunkIndex: 0, text: "B 资料" }], dimension: 2,
      fileChecksums: {}, embeddingModel: "mock", embeddingSpace: await ragEmbeddingFingerprint('mock',setting.embeddingBaseUrl), chunkSize: 500, chunkOverlap: 100 };
    await saveRagSnapshot(vault.app, "B", b, new Float32Array([1, 0]), "LLMHub");
    localRag.resetLocalRagStore();
    const combined = { ...setting, sourceRagSettings: ["A", "B"] };
    await localRag.initLocalRagStore().load(vault.app, ["A", "B", "Combined"], { A: setting, B: setting, Combined: combined });
    const result = await retrieve({ ...request, settingName: "Combined", setting: combined });
    expect(result.status).toBe("success");
    expect(result.results.map((item: any) => item.filePath)).toEqual(["A/0.md", "B/other.md"]);
  });

  it("preserves the optional Jev filtering step for explicit retrieval", async () => {
    const { request } = await fixture(2);
    stub.jev.mockImplementation(async (_query, results) => [results[1]]);
    const result = await retrieve({ ...request, settings: { ...settings, jevRagFilterEnabled: true, jevApiKey: "placeholder" } });
    expect(stub.jev).toHaveBeenCalledOnce();
    expect(result.results.map((item: any) => item.filePath)).toEqual(["A/1.md"]);
  });

  it("searches an external index with its stored embedding model", async () => {
    const { vault, request } = await fixture(0);
    const index: LocalRagIndex = { meta: [{ filePath: "C:/synthetic/source.md", chunkIndex: 0, text: "external" }],
      dimension: 2, fileChecksums: {}, embeddingModel: "stored-model", embeddingSpace: await ragEmbeddingFingerprint('stored-model',setting.embeddingBaseUrl), chunkSize: 500, chunkOverlap: 100 };
    const binary = Buffer.from(new Float32Array([1, 0]).buffer);
    const fs = { promises: {
      access: async (path: string) => { if (path.endsWith("/.snapshots")) throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      readFile: async (path: string) => path.endsWith("index.json") ? JSON.stringify(index) : binary,
      stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    } };
    const original = Object.getOwnPropertyDescriptor(window, "require");
    Object.defineProperty(window, "require", { configurable: true, value: (name: string) => name === "fs" ? fs : { join: (...parts: string[]) => parts.join("/") } });
    try {
      localRag.resetLocalRagStore(); const external = { ...setting, externalIndexPath: "C:/synthetic/index" };
      await localRag.initLocalRagStore().load(vault.app, ["External"], { External: external });
      const result = await retrieve({ ...request, settingName: "External", setting: external });
      expect(result).toMatchObject({ status: "success", results: [{ filePath: "C:/synthetic/source.md", sourceStatus: "missing" }] });
      expect(stub.embed.mock.calls[0][2]).toBe("stored-model");
    } finally {
      if (original) Object.defineProperty(window, "require", original); else Reflect.deleteProperty(window, "require");
    }
  });
});
