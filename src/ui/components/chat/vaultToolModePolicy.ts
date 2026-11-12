import type { VaultToolMode, VaultToolNoneReason } from "src/types";
export { getVaultToolDiagnostics, localToolRestrictionDetail, readProxyReadOnlyStatus } from "./vaultToolDiagnostics";

/**
 * Native safety default for every independent chat context.
 *
 * The user's desired mode is kept separate from the effective mode because
 * some providers cannot expose Vault tools at all. A temporary capability
 * restriction must not erase the user's safety preference.
 */
export const DEFAULT_DESIRED_VAULT_TOOL_MODE: VaultToolMode = "readOnly";

export interface VaultToolModePolicyInput {
  desiredMode: VaultToolMode;
  restrictedByModel: boolean;
  gemmaSearchConflict: boolean;
}

export interface VaultToolModePolicyResult {
  effectiveMode: VaultToolMode;
  noneReason: VaultToolNoneReason | null;
}

/**
 * Resolve the mode that can actually be exposed to the current model.
 *
 * Priority:
 * 1. Provider/model capability restriction
 * 2. Gemma search/function-calling incompatibility
 * 3. User's desired mode
 */
export function resolveVaultToolModePolicy(
  input: VaultToolModePolicyInput,
): VaultToolModePolicyResult {
  if (input.restrictedByModel) {
    return {
      effectiveMode: "none",
      noneReason: "cli",
    };
  }

  if (input.gemmaSearchConflict) {
    return {
      effectiveMode: "none",
      noneReason: "manual",
    };
  }

  return {
    effectiveMode: input.desiredMode,
    noneReason: input.desiredMode === "none" ? "manual" : null,
  };
}
