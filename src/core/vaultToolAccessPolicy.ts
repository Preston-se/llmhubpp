import type { ToolDefinition, VaultToolMode } from "src/types";
import {
  filterVaultToolsForMode,
  getEnabledVaultTools,
  isVaultToolAllowed,
} from "obsidian-llm-hub-common/core";
import { HOST_EXECUTES_RAG_SYNC_STATUS } from "src/vault/toolExecutor";
import { READ_NOTE_RANGE_PROPERTIES } from 'src/vault/readNoteRange';

/**
 * Vault capabilities implemented by this host.
 *
 * Keep this separate from the per-chat VaultToolMode:
 * capabilities describe what LLM Hub CAN execute;
 * VaultToolMode describes what the current chat MAY execute.
 */
const HOST_VAULT_CAPABILITIES = {
  allowWrite: true,
  allowDelete: true,
  ragSyncStatus: HOST_EXECUTES_RAG_SYNC_STATUS,
} as const;

/**
 * Full set of safe, advertised built-in Vault tools supported by this host,
 * before the per-chat Vault mode is applied.
 *
 * Unsafe legacy update_note/delete_note are already excluded by the shared
 * getEnabledVaultTools policy.
 */
export function getHostVaultTools(): ToolDefinition[] {
  return getEnabledVaultTools(HOST_VAULT_CAPABILITIES).map(tool=>tool.name==='read_note'?{...tool,parameters:{...tool.parameters,properties:{...tool.parameters.properties,...READ_NOTE_RANGE_PROPERTIES}}}:tool);
}

/**
 * Built-in Vault tools that may be advertised to the current chat.
 */
export function buildVaultToolPayload(
  mode: VaultToolMode,
): ToolDefinition[] {
  return filterVaultToolsForMode(
    getHostVaultTools(),
    mode,
  );
}

/**
 * Apply Vault access policy to a mixed tool bundle.
 *
 * External MCP, skill, RAG, workflow and sandbox tools are intentionally
 * preserved because isVaultToolAllowed only controls built-in Vault tools.
 */
export function filterToolBundleForVaultMode<
  T extends { name: string },
>(
  tools: T[],
  mode: VaultToolMode,
): T[] {
  return tools.filter((tool) =>
    isVaultToolAllowed(tool.name, mode)
  );
}

/**
 * Execution-time backstop.
 *
 * Payload filtering is the first boundary, but a stale conversation,
 * malformed provider response or future regression must not be able to invoke
 * a built-in Vault tool that the current mode forbids.
 */
export function getVaultToolExecutionBlock(
  name: string,
  mode: VaultToolMode,
): { error: string } | null {
  if (isVaultToolAllowed(name, mode)) {
    return null;
  }

  return {
    error: `Vault tool is disabled in ${mode} mode: ${name}`,
  };
}
