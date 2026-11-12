import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { DEFAULT_RAG_SETTING } from "src/types";
const native = vi.hoisted(() => vi.fn());
vi.mock("@google/genai", async original => ({ ...await original<object>(), GoogleGenAI: class { models = { embedContent: native }; apiClient = { apiCall: vi.fn() }; interactions = { getClient: () => ({ _httpClient: { request: vi.fn() } }) }; } }));
import { retrieveGroundedContext } from "./groundedRetrieval";
import { fetchEmbeddingModels, generateEmbeddings } from "./embeddingProvider";
import { initLocalRagStore, resetLocalRagStore } from "./localRagStore";
import { ragEmbeddingFingerprint, saveRagSnapshot } from "./localRagStorage";
import { memoryVault } from "./testSupport/memoryVault";

const transport = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async original => ({ ...await original<object>(), requestUrl: (options: { url: string; method: string; headers?: Record<string, string> }) => transport(options.url, { method: options.method, headers: options.headers }).then(async (response: Response) => ({ status: response.status, json: await response.json() })) }));
vi.mock("./proxyFetch", () => ({ createNodeFetch: () => transport, createProxyFetch: () => transport }));

const childOrigin = "https://synthetic-child.invalid";
const mergedOrigin = "https://synthetic-parent.invalid";
const syntheticGeminiCredential = "audit-gemini-placeholder";
const syntheticParentCredential = "audit-parent-placeholder";
const childSetting = {
  ...DEFAULT_RAG_SETTING, embeddingModel: "synthetic-model", embeddingBaseUrl: childOrigin,
  embeddingApiKey: "", targetFolders: ["Notes"], scoreThreshold: 0,
};
const query = "synthetic audit query";

beforeEach(() => {
  native.mockReset().mockResolvedValue({ embeddings: [{ values: [1, 0] }] });
  transport.mockReset().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: [1, 0] }] }),
  }));
});
afterEach(resetLocalRagStore);

async function retrieve(source: "Child" | "Merged", mergedKey = syntheticParentCredential, childKey = "", baseUrl = childOrigin) {
  const vault = memoryVault();
  const notePath = "Notes/synthetic.md";
  const note = Object.assign(new TFile(), { path: notePath });
  vault.app.vault.getAbstractFileByPath = path => path === notePath ? note : null;
  await saveRagSnapshot(vault.app, "Child", {
    meta: [{ filePath: notePath, text: "synthetic fixture excerpt", chunkIndex: 0 }],
    fileChecksums: {}, dimension: 2, embeddingModel: childSetting.embeddingModel,
    embeddingSpace: await ragEmbeddingFingerprint(childSetting.embeddingModel, baseUrl),
    chunkSize: 800, chunkOverlap: 150,
  }, new Float32Array([1, 0]), "LLMHub");
  const settings = {
    Child: { ...childSetting, embeddingApiKey: childKey, embeddingBaseUrl: baseUrl },
    Merged: { ...childSetting, embeddingApiKey: mergedKey, embeddingBaseUrl: mergedOrigin, sourceRagSettings: ["Child"] },
  };
  await initLocalRagStore().load(vault.app, Object.keys(settings), settings);
  return retrieveGroundedContext({
    app: vault.app, settingName: source, query, setting: settings[source], fallbackApiKey: syntheticGeminiCredential,
    settings: { apiProviders: [{ id: "gateway", name: "Gateway", type: "gemini", enabled: true, baseUrl: mergedOrigin, apiKey: syntheticGeminiCredential, enabledModels: [], availableModels: [], verified: true }], proxyUrl: "", proxyBypass: "", jevRagFilterEnabled: false, jevApiKey: "", jevUseOpenRouter: false },
  });
}

describe("embedding credential ownership", () => {
  it.each(["Child", "Merged"] as const)("does not send Gemini or parent credentials to an unauthenticated %s destination", async name => {
    expect(await retrieve(name)).toMatchObject({ status: "success" });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(childOrigin + "/v1/embeddings");
    expect(new Headers(request.headers).has("authorization")).toBe(false);
    expect(JSON.parse(request.body)).toEqual({ model: "synthetic-model", input: [query] });
  });

  it("uses the configured child credential for that child destination", async () => {
    expect(await retrieve("Merged", syntheticParentCredential, "audit-child-placeholder")).toMatchObject({ status: "success" });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(childOrigin + "/v1/embeddings");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer audit-child-placeholder");
  });

  it("does not use a nonofficial Gemini provider's credential for native embeddings", async () => {
    expect(await retrieve("Child", "", "", "")).toMatchObject({ status: "not-ready", reason: "embedding-missing" });
    expect(transport).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("requires redirect-safe transport when listing embedding models", async () => {
    transport.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "test-embedding" }] })));
    expect(await fetchEmbeddingModels("audit-model-key", childOrigin)).toEqual(["test-embedding"]);
    const [url, request] = transport.mock.calls.at(-1)!;
    expect(url).toBe(childOrigin + "/v1/models");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer audit-model-key");
    expect(request.redirect).toBe("error");
  });

  it.each([undefined, "http://proxy.invalid:8080"])("blocks embedding redirects before resending the body, proxy=%s", async proxy => {
    transport.mockResolvedValue(new Response(null, { status: 307, headers: { location: mergedOrigin } }));
    await expect(generateEmbeddings(["synthetic note"], "audit-embedding-key", "model", childOrigin, proxy)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(childOrigin + "/v1/embeddings");
    expect(request.redirect).toBe("error");
  });
});

