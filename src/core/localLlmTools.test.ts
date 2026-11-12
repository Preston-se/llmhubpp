import { describe, expect, it } from "vitest";
import { isLocalLlmToolsEnabled, isToolsCompatibleFramework, type LocalLlmConfig } from "../types";
import { localLlmToolEndpoint } from "./localLlmEndpoint";

function config(framework: LocalLlmConfig["framework"]): LocalLlmConfig {
  return { id: "test", framework, baseUrl: "http://localhost", model: "provider/model" };
}

describe("local LLM tool capability", () => {
  it("offers Ollama tools through its compatible endpoint and respects rejection records", () => {
    const value = config("ollama"); value.baseUrl = "http://localhost:11434/api/chat";
    expect(isLocalLlmToolsEnabled(value, value.model)).toBe(true);
    expect(localLlmToolEndpoint(value)).toBe("http://localhost:11434");
    value.toolsUnsupportedModels = [value.model];
    expect(isLocalLlmToolsEnabled(value, value.model)).toBe(false);
    expect(localLlmToolEndpoint({ ...value, baseUrl: "http://localhost:11434/prefix/v1/" })).toBe("http://localhost:11434/prefix");
    expect(localLlmToolEndpoint({ ...value, framework: "vllm", baseUrl: "http://localhost/custom/v1" })).toBe("http://localhost/custom/v1");
  });
  it("enables OpenCode tools through its MCP path without treating it as OpenAI-compatible", () => {
    expect(isToolsCompatibleFramework("opencode")).toBe(false);
    expect(isLocalLlmToolsEnabled(config("opencode"), "provider/model")).toBe(true);
  });

  it("honors the per-model tools blocklist for OpenCode", () => {
    const value = config("opencode");
    value.toolsUnsupportedModels = ["provider/model"];
    expect(isLocalLlmToolsEnabled(value, "provider/model")).toBe(false);
  });
});
