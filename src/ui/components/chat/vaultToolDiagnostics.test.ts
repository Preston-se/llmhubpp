import { describe, expect, it } from "vitest";
import * as policy from "./vaultToolModePolicy";
import type { VaultToolDiagnosticsInput } from "./vaultToolDiagnostics";

function diagnose(input: Partial<VaultToolDiagnosticsInput> = {}) {
  return policy.getVaultToolDiagnostics({
    desiredMode: "readOnly",
    effectiveMode: "readOnly",
    modelRestricted: false,
    searchConflict: false,
    proxyReadOnly: false,
    scopeEnforced: true,
    allowedFolders: [],
    ...input,
  });
}

describe("vault tool diagnostics", () => {
  it("reports the read-only mode and unrestricted scope for a new chat", () => {
    const diagnose = (policy as unknown as {
      getVaultToolDiagnostics?: (input: unknown) => unknown;
    }).getVaultToolDiagnostics;
    expect(diagnose?.({
      desiredMode: "readOnly",
      effectiveMode: "readOnly",
      modelRestricted: false,
      searchConflict: false,
      proxyReadOnly: true,
      scopeEnforced: true,
      allowedFolders: [],
    })).toMatchObject({
      desiredMode: "readOnly",
      effectiveMode: "readOnly",
      reason: null,
      proxyReadOnly: true,
      scope: "whole-vault",
      allowedFolders: [],
    });
  });

  it("shows that All remains limited to the configured folders", () => {
    const folders = ["Study", "Notes/Public"];
    const result = diagnose({ desiredMode: "all", effectiveMode: "all", allowedFolders: folders });
    expect(result).toMatchObject({ effectiveMode: "all", scope: "folders", allowedFolders: folders });
    result.allowedFolders.push("Elsewhere");
    expect(folders).toEqual(["Study", "Notes/Public"]);
  });

  it("distinguishes a model limitation from the separate proxy read-only policy", () => {
    expect(diagnose({ desiredMode: "all", effectiveMode: "none", modelRestricted: true, proxyReadOnly: true }))
      .toMatchObject({ desiredMode: "all", effectiveMode: "none", reason: "model", proxyReadOnly: true });
    expect(diagnose({ desiredMode: "all", effectiveMode: "none", searchConflict: true, proxyReadOnly: null }))
      .toMatchObject({ reason: "search-conflict", proxyReadOnly: null });
  });

  it("does not present the folder restriction as enforced on a provider that bypasses it", () => {
    expect(diagnose({ scopeEnforced: false, allowedFolders: ["Study"] }).scope).toBe("not-enforced");
  });

  it("allows Ollama compatibility tools while distinguishing a model that rejected them", () => {
    const detail = (policy as unknown as { localToolRestrictionDetail?: (config: unknown) => string | null }).localToolRestrictionDetail;
    expect(detail?.({ framework: "ollama", model: "small" })).toBeNull();
    expect(detail?.({ framework: "ollama", model: "small", toolsUnsupportedModels: ["small"] })).toBe("auto-disabled");
    expect(detail?.({ framework: "vllm", model: "small", toolsUnsupportedModels: ["small"] })).toBe("auto-disabled");
    expect(detail?.({ framework: "vllm", model: "other", toolsUnsupportedModels: ["small"] })).toBeNull();
  });

  it("reflects switching models or starting a new chat without changing the desired mode or folders", () => {
    const folders = ["Study"];
    const shared = { desiredMode: "all" as const, allowedFolders: folders };
    expect(diagnose({ ...shared, effectiveMode: "none", modelRestricted: true }).desiredMode).toBe("all");
    expect(diagnose({ ...shared, effectiveMode: "all" }).effectiveMode).toBe("all");
    expect(diagnose({ allowedFolders: folders }).effectiveMode).toBe("readOnly");
    expect(folders).toEqual(["Study"]);
  });

  it("reports proxy policy only when the proxy is listening, independently of the router toggle", () => {
    const readStatus = (policy as unknown as {
      readProxyReadOnlyStatus?: (guard: unknown) => boolean | null;
    }).readProxyReadOnlyStatus;
    expect(readStatus?.(undefined)).toBeNull();
    expect(readStatus?.({ server: { listening: false }, shouldEnforceProxyReadOnly: () => true })).toBeNull();
    expect(readStatus?.({ settings: { enabled: false }, server: { listening: true }, shouldEnforceProxyReadOnly: () => true })).toBe(true);
    expect(readStatus?.({ settings: { enabled: true }, server: { listening: true }, shouldEnforceProxyReadOnly: () => false })).toBe(false);
  });
});
