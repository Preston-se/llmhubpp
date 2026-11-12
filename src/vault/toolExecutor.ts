// The built-in Vault tools live in the shared library. What stays here is this
// host's execution context and the flag saying which tools it can answer.
import type { App } from "obsidian";
import {
  executeVaultTool,
  findFolderByPath,
  type VaultToolExecutionContext,
  type VaultToolResult,
} from "obsidian-llm-hub-common/vault";
import { isPathInAllowedVaultFolders, VAULT_TOOL_SCOPE_DENIED_MSG } from "obsidian-llm-hub-common/core";
import { readNoteRange } from './readNoteRange';

/**
 * Whether this host can answer `get_rag_sync_status`. Its RAG store keeps no
 * per-file import state, so no executor answers the tool and
 * `getEnabledVaultTools` must not advertise it. Flip this the day one exists;
 * toolExecutor.contract.test.ts fails if the two ever disagree.
 */
export const HOST_EXECUTES_RAG_SYNC_STATUS = false;

export type ToolResult = VaultToolResult;
export type ToolExecutionContext = VaultToolExecutionContext;

/** Keep a provider's tool-result stream truthful even if a host tool throws. */
export function withToolFailureResult(
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  signal?: AbortSignal,
): (name: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (name, args) => {
    try { return await execute(name, args); }
    catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      return { success: false, error: "Tool execution failed" };
    }
  };
}

// Match the shared executor's argument coercion before resolving its destination.
function asToolString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return undefined; }
}

function resolvedCreateTargetIsAllowed(app: App, args: Record<string, unknown>, context?: ToolExecutionContext): boolean {
  const folders = context?.vaultToolAllowedFolders;
  if (!context?.limitVaultToolScope || !folders?.length) return true;
  let name = asToolString(args.name);
  let folder = asToolString(args.folder);
  if (!name && args.path) {
    const path = asToolString(args.path) || "";
    const slash = path.lastIndexOf("/");
    if (slash >= 0) {
      name = path.slice(slash + 1);
      folder = folder ?? path.slice(0, slash);
    } else name = path;
  }
  if (!folder || !name) return true; // The shared executor checks the requested path and required fields.
  const resolvedFolder = findFolderByPath(app, folder);
  return !resolvedFolder || isPathInAllowedVaultFolders(`${resolvedFolder.path}/${name}`, folders);
}

export async function executeToolCall(
  app: App,
  toolName: string,
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  if(toolName==='read_note'){
    try { const result=await readNoteRange(app,args,context);if(result)return result; }
    catch { return {success:false,error:'Unable to read the requested note range.'}; }
  }
  if (toolName === "create_note") {
    try {
      if (!resolvedCreateTargetIsAllowed(app, args, context)) {
        return { success: false, error: VAULT_TOOL_SCOPE_DENIED_MSG, allowedFolders: [...(context?.vaultToolAllowedFolders ?? [])] };
      }
    } catch {
      // Fail closed if the actual target cannot be verified.
      return { success: false, error: "Unable to verify the target folder for the configured vault scope." };
    }
  }
  const result = await executeVaultTool(app, toolName, args, context);
  if (result.error === VAULT_TOOL_SCOPE_DENIED_MSG && context?.limitVaultToolScope) {
    return { ...result, allowedFolders: [...(context.vaultToolAllowedFolders ?? [])] };
  }
  return result;
}

export function createToolExecutor(
  app: App,
  context?: ToolExecutionContext,
): (name: string, args: Record<string, unknown>) => Promise<unknown> {
  return (name, args) => executeToolCall(app, name, args, context);
}
