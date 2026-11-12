import type { LocalLlmConfig, VaultToolMode } from "src/types";

export function localToolRestrictionDetail(config: Pick<LocalLlmConfig, "framework" | "model" | "toolsUnsupportedModels"> | null): "native-ollama" | "auto-disabled" | null {
  if (!config) return null;
  return config.toolsUnsupportedModels?.includes(config.model) ? "auto-disabled" : null;
}

export interface VaultToolDiagnosticsInput {
  desiredMode: VaultToolMode;
  effectiveMode: VaultToolMode;
  modelRestricted: boolean;
  searchConflict: boolean;
  /** A proxy policy, not a guarantee about requests that bypass the proxy. */
  proxyReadOnly: boolean | null;
  scopeEnforced: boolean;
  allowedFolders: readonly string[];
  modelDetail?: "native-ollama" | "auto-disabled" | null;
}

export function readProxyReadOnlyStatus(guard: {
  server?: { listening?: boolean } | null;
  shouldEnforceProxyReadOnly?: () => boolean;
} | undefined): boolean | null {
  if (guard?.server?.listening !== true || typeof guard.shouldEnforceProxyReadOnly !== "function") return null;
  return guard.shouldEnforceProxyReadOnly();
}

export function getVaultToolDiagnostics(input: VaultToolDiagnosticsInput) {
  const allowedFolders = [...input.allowedFolders];
  return {
    desiredMode: input.desiredMode,
    effectiveMode: input.effectiveMode,
    reason: input.modelRestricted ? "model" : input.searchConflict ? "search-conflict" : null,
    modelDetail: input.modelDetail ?? null,
    proxyReadOnly: input.proxyReadOnly,
    scope: !input.scopeEnforced ? "not-enforced" : allowedFolders.length ? "folders" : "whole-vault",
    allowedFolders,
  } as const;
}

export type VaultToolDiagnostics = ReturnType<typeof getVaultToolDiagnostics>;
