import { normalizeServerBaseUrl } from "obsidian-llm-hub-common/core";
import type { LlmHubSettings, RagSetting } from "../types";

export const OFFICIAL_GEMINI_EMBEDDING_ORIGIN = "https://generativelanguage.googleapis.com";

type EmbeddingSetting = Pick<RagSetting, "embeddingApiKey" | "embeddingBaseUrl" | "embeddingApiKeyConfigured">;
type EmbeddingSettings = Pick<LlmHubSettings, "apiProviders">;

export function normalizeEmbeddingBaseUrl(value: string): string {
  const url = new URL(normalizeServerBaseUrl(value));
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid embedding endpoint");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Include the transport kind so switching between native and compatible APIs requires a fresh decision. */
export function embeddingDestinationIdentity(value: string | undefined): string {
  return value?.trim() ? `custom:${normalizeEmbeddingBaseUrl(value)}` : "gemini:" + OFFICIAL_GEMINI_EMBEDDING_ORIGIN;
}

export function getOfficialGeminiEmbeddingApiKey(settings?: EmbeddingSettings): string {
  for (const provider of settings?.apiProviders ?? []) {
    if (provider.type !== "gemini" || !provider.enabled || !provider.apiKey?.trim()) continue;
    try {
      if (new URL(normalizeEmbeddingBaseUrl(provider.baseUrl)).origin === OFFICIAL_GEMINI_EMBEDDING_ORIGIN) {
        return provider.apiKey.trim();
      }
    } catch { /* An invalid provider URL cannot establish credential ownership. */ }
  }
  return "";
}

export interface EmbeddingConnection {
  kind: "custom" | "gemini";
  status: "ready" | "missing-key" | "invalid-endpoint";
  destination: string;
  baseUrl?: string;
  apiKey: string;
}

export function resolveEmbeddingConnection(setting?: Partial<EmbeddingSetting> | null, settings?: EmbeddingSettings): EmbeddingConnection {
  const explicitKey = setting?.embeddingApiKey?.trim() ?? "";
  if (setting?.embeddingBaseUrl?.trim()) {
    try {
      const baseUrl = normalizeEmbeddingBaseUrl(setting.embeddingBaseUrl);
      return { kind: "custom", status: !explicitKey && setting.embeddingApiKeyConfigured ? "missing-key" : "ready", destination: baseUrl, baseUrl, apiKey: explicitKey };
    } catch {
      return { kind: "custom", status: "invalid-endpoint", destination: "", apiKey: "" };
    }
  }
  const apiKey = explicitKey || (setting?.embeddingApiKeyConfigured ? "" : getOfficialGeminiEmbeddingApiKey(settings));
  return { kind: "gemini", status: apiKey ? "ready" : "missing-key", destination: OFFICIAL_GEMINI_EMBEDDING_ORIGIN, apiKey };
}
