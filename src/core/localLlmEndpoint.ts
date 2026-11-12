import type { LocalLlmConfig } from "src/types";

/** The provider appends /v1 itself; return its base, not a second version suffix. */
export function localLlmToolEndpoint(config: Pick<LocalLlmConfig, "framework" | "baseUrl">): string {
  if (config.framework !== "ollama") return config.baseUrl;
  const url = new URL(config.baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:api(?:\/chat)?|v1(?:\/chat\/completions)?)$/, "");
  return url.toString().replace(/\/$/, "");
}
