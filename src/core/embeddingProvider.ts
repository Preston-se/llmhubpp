import {cachedEmbeddingBatch} from './embeddingCache';
import { Platform } from "obsidian";
import { GoogleGenAI, type Part } from "@google/genai";
import type { RagContentType } from "./localRagStorage";
import { createProxyFetch, createNodeFetch } from "./proxyFetch";
import { controlledRequest, type WorkControl } from "./taskManager";
import { normalizeEmbeddingBaseUrl, OFFICIAL_GEMINI_EMBEDDING_ORIGIN } from "./embeddingCredentials";
import {
  authHeaders,
  fetchEmbeddingModels as fetchEmbeddingModelsShared,
  isEmbeddingModelName,
  parseOpenAiModels,
} from "obsidian-llm-hub-common/core";

const EMBEDDING_API_URL = `${OFFICIAL_GEMINI_EMBEDDING_ORIGIN}/v1beta/openai/embeddings`;
const GEMINI_MODELS_URL = `${OFFICIAL_GEMINI_EMBEDDING_ORIGIN}/v1beta/openai/models`;
const BATCH_SIZE = 32;

/** Supported multimodal extensions for embedding */
export const MULTIMODAL_EXTENSIONS = new Set(["png", "jpg", "jpeg", "pdf", "mp3", "wav", "mp4", "mpeg"]);

/**
 * File size limits per extension (bytes).
 * Gemini Embedding 2 has no explicit size limit for images/PDFs.
 * Audio and video have duration limits (80-120s), so we apply generous size limits as a safeguard.
 */
export const MULTIMODAL_FILE_SIZE_LIMITS: Record<string, number> = {
  mp3: 20 * 1024 * 1024,
  wav: 100 * 1024 * 1024,
  mp4: 200 * 1024 * 1024,
  mpeg: 200 * 1024 * 1024,
};

/** Map file extension to MIME type (per Gemini Embedding 2 spec) */
export function extensionToMimeType(ext: string): string | null {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
  };
  return map[ext.toLowerCase()] ?? null;
}

/** Map file extension to RAG content type */
export function extensionToContentType(ext: string): RagContentType {
  const map: Record<string, RagContentType> = {
    md: "text",
    png: "image",
    jpg: "image",
    jpeg: "image",
    pdf: "pdf",
    mp3: "audio",
    wav: "audio",
    mp4: "video",
    mpeg: "video",
  };
  return map[ext.toLowerCase()] ?? "text";
}

function embeddingFetch(proxyUrl?: string, proxyBypass?: string): typeof fetch {
  const fetchTarget = proxyUrl ? createProxyFetch(proxyUrl, proxyBypass) : Platform?.isMobile
    ? window.fetch.bind(window) : createNodeFetch();
  return async (input, init) => {
    const response = await fetchTarget(input, { ...init, redirect: "error" });
    if (response.redirected || response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Embedding endpoint redirected the request. Configure the final service address.");
    }
    return response;
  };
}

/**
 * The embedding models available: Gemini's own listing when no server is
 * configured, and otherwise whatever that server offers.
 */
export async function fetchEmbeddingModels(
  apiKey: string,
  baseUrl?: string,
  proxyUrl?: string,
  proxyBypass?: string,
): Promise<string[]> {
  const fetchTarget = embeddingFetch(proxyUrl, proxyBypass);
  const get = async (url: string, headers: Record<string, string>) => {
    const response = await fetchTarget(url, { method: "GET", headers });
    if (!response.ok) throw new Error(`Embedding models request failed: HTTP ${response.status}`);
    return await response.json() as unknown;
  };

  if (!baseUrl) {
    // Gemini lists every model it has, embedding or not.
    return parseOpenAiModels(await get(GEMINI_MODELS_URL, authHeaders(apiKey))).filter(isEmbeddingModelName);
  }
  return await fetchEmbeddingModelsShared({ baseUrl: normalizeEmbeddingBaseUrl(baseUrl), apiKey }, get);
}

/**
 * Generate embeddings via OpenAI-compatible /v1/embeddings endpoint (text only).
 * Used for non-Gemini providers (Ollama, LM Studio, etc.) and Gemini text-only mode.
 */
export async function generateEmbeddings(
  texts: string[],
  apiKey: string,
  model: string,
  baseUrl?: string,
  proxyUrl?: string,
  proxyBypass?: string,
  control?: WorkControl,
): Promise<number[][]> {
  const results: number[][] = [];
  const url = baseUrl
    ? `${normalizeEmbeddingBaseUrl(baseUrl)}/v1/embeddings`
    : EMBEDDING_API_URL;

  const fetchTarget = embeddingFetch(proxyUrl, proxyBypass);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    await control?.checkpoint();
    const batch = texts.slice(i, i + BATCH_SIZE);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const body = JSON.stringify({ model, input: batch });

    const rows = await cachedEmbeddingBatch(control, {kind:'openai',model,url,input:batch}, batch.length, async () => {
      const data = await controlledRequest(control, async signal => {
        const response = await fetchTarget(url, { method: "POST", headers, body, signal });
        if (!response.ok) throw new Error(`Embedding API error: ${response.status}`);
        return await response.json() as { data: Array<{ embedding: number[] }> };
      });
      if (!Array.isArray(data.data) || data.data.length !== batch.length) throw new Error("嵌入服务返回数量与请求不一致，未提交该文档索引");
      return data.data.map(item => item.embedding);
    });
    await appendConsistentEmbeddings(results,rows,control);
    control?.update("生成RAG向量", Math.min(i + batch.length, texts.length), texts.length);
    await control?.checkpoint();
  }

  return results;
}

/**
 * Input for Gemini native multimodal embedding.
 * Each input can be text, or binary data (image/PDF/audio/video).
 */
export interface GeminiEmbeddingInput {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/**
 * Generate embeddings via Gemini native SDK (supports multimodal inputs).
 * Each input is embedded individually to respect per-request media limits.
 */
async function generateGeminiNativeEmbeddingsUncached(
  inputs: GeminiEmbeddingInput[],
  apiKey: string,
  model: string,
  outputDimensionality?: number,
  proxyUrl?: string,
  proxyBypass?: string,
  control?: WorkControl,
): Promise<number[][]> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: OFFICIAL_GEMINI_EMBEDDING_ORIGIN, retryOptions: { attempts: 1 } } });
  const client = (ai as unknown as { apiClient?: { apiCall: (url: string, init: RequestInit) => Promise<Response> } }).apiClient;
  if (typeof client?.apiCall !== "function") throw new Error("Gemini embedding transport is unavailable");
  const fetchTarget = embeddingFetch(proxyUrl, proxyBypass);
  client.apiCall = (url, init) => {
    if (new URL(url).origin !== OFFICIAL_GEMINI_EMBEDDING_ORIGIN) throw new Error("Gemini embedding endpoint does not match its credential");
    return fetchTarget(url, init);
  };

  // Separate text-only inputs (can be batched) from multimodal inputs (one at a time)
  const textOnlyIndices: number[] = [];
  const multimodalIndices: number[] = [];

  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i].text && !inputs[i].inlineData) {
      textOnlyIndices.push(i);
    } else {
      multimodalIndices.push(i);
    }
  }

  const embeddings = new Array<number[]>(inputs.length);

  // Build config with optional output dimensionality
  const config = { ...(outputDimensionality ? {outputDimensionality} : {}), abortSignal: control?.signal };

  // Batch text-only inputs in chunks of 100 (Gemini batch limit)
  const BATCH_LIMIT = 100;
  if (model.includes("gemini-embedding-2")) {
    for (const idx of textOnlyIndices) {
      await control?.checkpoint();
      const response = await controlledRequest(control, signal => ai.models.embedContent({
        model,
        contents: inputs[idx].text!,
        config: {...config, abortSignal: signal},
      }));
      embeddings[idx] = response.embeddings?.[0]?.values ?? [];
    }
  } else {
    for (let start = 0; start < textOnlyIndices.length; start += BATCH_LIMIT) {
      const batchIndices = textOnlyIndices.slice(start, start + BATCH_LIMIT);
      const textContents = batchIndices.map(i => inputs[i].text!);
      await control?.checkpoint();
      const response = await controlledRequest(control, signal => ai.models.embedContent({
        model,
        contents: textContents,
        config: {...config, abortSignal: signal},
      }));
      if (response.embeddings) {
        for (let i = 0; i < response.embeddings.length; i++) {
          embeddings[batchIndices[i]] = response.embeddings[i].values ?? [];
        }
      }
    }
  }

  // Process multimodal inputs one at a time
  for (const idx of multimodalIndices) {
    await control?.checkpoint();
    const input = inputs[idx];
    const parts: Part[] = [];
    if (input.text) {
      parts.push({ text: input.text });
    }
    if (input.inlineData) {
      parts.push({
        inlineData: {
          mimeType: input.inlineData.mimeType,
          data: input.inlineData.data,
        },
      });
    }

    const response = await controlledRequest(control, signal => ai.models.embedContent({
      model,
      contents: [{ role: "user", parts }],
      config: {...config, abortSignal: signal},
    }));
    if (response.embeddings && response.embeddings.length > 0) {
      embeddings[idx] = response.embeddings[0].values ?? [];
    } else {
      embeddings[idx] = [];
    }
  }

  return Array.from({ length: inputs.length }, (_, i) => embeddings[i] ?? []);
}

export async function generateGeminiNativeEmbeddings(inputs:GeminiEmbeddingInput[],apiKey:string,model:string,outputDimensionality?:number,proxyUrl?:string,proxyBypass?:string,control?:WorkControl):Promise<number[][]>{
 const rows:number[][]=[];
 for(let start=0;start<inputs.length;){
  const size=model.includes('gemini-embedding-2')||inputs[start].inlineData?1:32;
  const batch=inputs.slice(start,start+size);
  const batchRows=await cachedEmbeddingBatch(control,{kind:'gemini',model,outputDimensionality,inputs:batch},batch.length,()=>generateGeminiNativeEmbeddingsUncached(batch,apiKey,model,outputDimensionality,proxyUrl,proxyBypass,control));
  await appendConsistentEmbeddings(rows,batchRows,control);
  start+=batch.length;control?.update('生成RAG向量',start,inputs.length);await control?.checkpoint();
 }
 return rows;
}

async function appendConsistentEmbeddings(target:number[][],rows:number[][],control?:WorkControl):Promise<void>{
  if(target.length&&rows.some(row=>row.length!==target[0].length)){
    await control?.batchCache?.clear?.();
    throw new Error('嵌入服务返回的向量维度发生变化，未提交该文档；缓存已失效，请检查模型设置后重试');
  }
  target.push(...rows);
}
