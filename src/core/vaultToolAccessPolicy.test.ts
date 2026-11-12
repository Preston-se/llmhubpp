import { describe, expect, it } from "vitest";
import {
  DELETE_VAULT_TOOL_NAMES,
  READ_ONLY_VAULT_TOOL_NAMES,
  SEARCH_VAULT_TOOL_NAMES,
  WRITE_VAULT_TOOL_NAMES,
} from "obsidian-llm-hub-common/core";
import {
  buildVaultToolPayload,
  filterToolBundleForVaultMode,
  getHostVaultTools,
  getVaultToolExecutionBlock,
} from "./vaultToolAccessPolicy";

const names = (tools: Array<{ name: string }>) =>
  tools.map((tool) => tool.name);

describe("vaultToolAccessPolicy payload filtering", () => {
  it("advertises the full safe host tool set in all mode", () => {
    const expected = [
      ...READ_ONLY_VAULT_TOOL_NAMES,
      ...WRITE_VAULT_TOOL_NAMES,
      ...DELETE_VAULT_TOOL_NAMES,
    ].sort();

    expect(names(buildVaultToolPayload("all")).sort())
      .toEqual(expected);

    // This host currently has no per-file RAG sync-status executor.
    expect(names(buildVaultToolPayload("all")))
      .not.toContain("get_rag_sync_status");

    // Unsafe legacy direct writers must never be advertised.
    expect(names(buildVaultToolPayload("all")))
      .not.toContain("update_note");
    expect(names(buildVaultToolPayload("all")))
      .not.toContain("delete_note");
  });

  it("advertises exactly the read-only tool set in readOnly mode", () => {
    expect(names(buildVaultToolPayload("readOnly")).sort())
      .toEqual([...READ_ONLY_VAULT_TOOL_NAMES].sort());
  });

  it("removes only discovery tools in noSearch mode", () => {
    const noSearch = names(buildVaultToolPayload("noSearch"));
    const all = names(buildVaultToolPayload("all"));

    for (const name of SEARCH_VAULT_TOOL_NAMES) {
      expect(noSearch).not.toContain(name);
    }

    expect(noSearch.sort()).toEqual(
      all
        .filter((name) => !SEARCH_VAULT_TOOL_NAMES.includes(name))
        .sort(),
    );

    // No Discovery is not Read Only.
    expect(noSearch).toContain("create_note");
    expect(noSearch).toContain("propose_edit");
    expect(noSearch).toContain("propose_delete");
  });

  it("advertises no built-in Vault tools in none mode", () => {
    expect(buildVaultToolPayload("none")).toEqual([]);
  });

  it("preserves non-Vault tools when applying Vault policy", () => {
    const mixed = [
      ...getHostVaultTools(),
      { name: "mcp_external_tool" },
      { name: "run_skill_workflow" },
      { name: "execute_javascript" },
    ];

    const readOnly = names(
      filterToolBundleForVaultMode(mixed, "readOnly"),
    );

    expect(readOnly).toContain("read_note");
    expect(readOnly).not.toContain("create_note");

    expect(readOnly).toContain("mcp_external_tool");
    expect(readOnly).toContain("run_skill_workflow");
    expect(readOnly).toContain("execute_javascript");

    const none = names(
      filterToolBundleForVaultMode(mixed, "none"),
    );

    expect(none).not.toContain("read_note");
    expect(none).not.toContain("create_note");

    expect(none).toContain("mcp_external_tool");
    expect(none).toContain("run_skill_workflow");
    expect(none).toContain("execute_javascript");
  });
});

describe("vaultToolAccessPolicy execution gate", () => {
  it("allows read operations in readOnly mode", () => {
    expect(
      getVaultToolExecutionBlock("read_note", "readOnly"),
    ).toBeNull();

    expect(
      getVaultToolExecutionBlock("search_notes", "readOnly"),
    ).toBeNull();

    expect(
      getVaultToolExecutionBlock(
        "get_active_note_info",
        "readOnly",
      ),
    ).toBeNull();
  });

  it("blocks every mutation family in readOnly mode", () => {
    for (const name of [
      "create_note",
      "create_folder",
      "rename_note",
      "propose_edit",
      "bulk_propose_edit",
      "bulk_propose_rename",
      "propose_delete",
      "bulk_propose_delete",
    ]) {
      expect(
        getVaultToolExecutionBlock(name, "readOnly"),
      ).toEqual({
        error: `Vault tool is disabled in readOnly mode: ${name}`,
      });
    }
  });

  it("blocks discovery but keeps mutations in noSearch mode", () => {
    expect(
      getVaultToolExecutionBlock(
        "search_notes",
        "noSearch",
      ),
    ).not.toBeNull();

    expect(
      getVaultToolExecutionBlock(
        "list_notes",
        "noSearch",
      ),
    ).not.toBeNull();

    expect(
      getVaultToolExecutionBlock(
        "create_note",
        "noSearch",
      ),
    ).toBeNull();

    expect(
      getVaultToolExecutionBlock(
        "propose_edit",
        "noSearch",
      ),
    ).toBeNull();
  });

  it("blocks all built-in Vault tools in none mode", () => {
    for (const tool of getHostVaultTools()) {
      expect(
        getVaultToolExecutionBlock(tool.name, "none"),
      ).not.toBeNull();
    }
  });

  it("does not interfere with external tools", () => {
    expect(
      getVaultToolExecutionBlock(
        "mcp_external_tool",
        "none",
      ),
    ).toBeNull();

    expect(
      getVaultToolExecutionBlock(
        "run_skill_workflow",
        "readOnly",
      ),
    ).toBeNull();

    expect(
      getVaultToolExecutionBlock(
        "execute_javascript",
        "readOnly",
      ),
    ).toBeNull();
  });
});
