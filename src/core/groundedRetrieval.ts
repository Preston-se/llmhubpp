import type { App } from "obsidian";
import { DEFAULT_RAG_SETTING, type LlmHubSettings, type RagSetting } from "src/types";
import { getLocalRagStore, RagEmbeddingError, RagVectorSpaceError, searchLocalRagResults, type AuthorizeRagDestination, type LocalRagSearchResult } from "./localRagStore";
import { resolveEmbeddingConnection } from "./embeddingCredentials";
import { cancellationError } from "./taskManager";
import { getRagSourceStatus, type SourceStatus } from "./ragSourceStatus";
export { getRagSourceStatus, type SourceStatus } from "./ragSourceStatus";

export type GroundedResult = LocalRagSearchResult & { sourceStatus: SourceStatus };
export interface GroundedRetrievalRequest {
  app: App;
  settingName: string;
  query: string;
  setting: RagSetting | null | undefined;
  fallbackApiKey: string;
  settings: Pick<LlmHubSettings, "apiProviders" | "proxyUrl" | "proxyBypass" | "jevRagFilterEnabled" | "jevApiKey" | "jevUseOpenRouter">;
  signal?: AbortSignal;
  authorize?: AuthorizeRagDestination;
}
interface RetrievalIdentity { settingName: string; query: string }
export type GroundedRetrieval =
  | (RetrievalIdentity & { status: "success"; results: GroundedResult[] })
  | (RetrievalIdentity & { status: "empty" | "cancelled" })
  | (RetrievalIdentity & { status: "not-ready"; reason: "store-unavailable" | "setting-not-found" | "index-empty" | "embedding-missing" | "query-empty" | "vector-space-unverified" | "vector-space-changed" })
  | (RetrievalIdentity & { status: "error"; reason: "embedding-unavailable" | "search-failed" });

function waitForResult<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(cancellationError()); };
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(value => { signal.removeEventListener("abort", cancel); resolve(value); }, error => {
      signal.removeEventListener("abort", cancel); reject(error instanceof Error ? error : new Error(String(error)));
    });
    if (signal.aborted) cancel();
  });
}

export async function retrieveGroundedContext(request: GroundedRetrievalRequest): Promise<GroundedRetrieval> {
  const identity = { settingName: request.settingName, query: request.query.trim() };
  if (request.signal?.aborted) return { ...identity, status: "cancelled" };
  if (!identity.query) return { ...identity, status: "not-ready", reason: "query-empty" };
  const store = getLocalRagStore();
  if (!store) return { ...identity, status: "not-ready", reason: "store-unavailable" };
  if (!request.setting) return { ...identity, status: "not-ready", reason: "setting-not-found" };
  if (!request.setting.sourceRagSettings.length && resolveEmbeddingConnection(request.setting, request.settings).status !== 'ready') {
    return { ...identity, status: "not-ready", reason: "embedding-missing" };
  }
  try {
    const index = await waitForResult(store.getStatus(request.app, request.settingName), request.signal);
    if (!index.chunkCount || !index.dimension) return { ...identity, status: "not-ready", reason: "index-empty" };
    const topK = Number.isFinite(request.setting.topK) ? Math.max(1, Math.min(999, Math.trunc(request.setting.topK))) : DEFAULT_RAG_SETTING.topK;
    const results = await waitForResult(searchLocalRagResults(request.settingName, identity.query, request.setting,
      request.fallbackApiKey, request.settings.proxyUrl, request.settings.proxyBypass, topK, request.settings, request.signal, request.authorize), request.signal);
    if (!results.length) return { ...identity, status: "empty" };
    const sources = await waitForResult(Promise.all(results.map(async result => ({
      ...result, sourceStatus: await getRagSourceStatus(request.app, result.originalFilePath ?? result.filePath),
    }))), request.signal);
    const current=sources.filter(result=>store.isResultCurrent(request.app,identity.settingName,result));
    return current.length?{ ...identity, status: "success", results: current }:{...identity,status:'empty'};
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) return { ...identity, status: "cancelled" };
    if(error instanceof RagVectorSpaceError)return {...identity,status:'not-ready',reason:error.kind==='unverified'?'vector-space-unverified':'vector-space-changed'};
    return { ...identity, status: "error", reason: error instanceof RagEmbeddingError ? "embedding-unavailable" : "search-failed" };
  }
}
