import { describe, expect, it } from "vitest";
import { TFolder, type App } from "obsidian";
import { getVaultToolExecutionBlock } from "src/core/vaultToolAccessPolicy";
import type { VaultToolMode } from "src/types";
import { createToolExecutor } from "./toolExecutor";

function syntheticVault(existingFolders: string[]) {
  const folders = existingFolders.map(path => Object.assign(new TFolder(), { path, name: path.split("/").at(-1) }));
  const files = new Map<string, string>();
  const app = {
    vault: {
      getAllLoadedFiles: () => folders,
      getAbstractFileByPath: (path: string) => files.has(path) ? { path } : null,
      createFolder: async (path: string) => { folders.push(Object.assign(new TFolder(), { path, name: path.split("/").at(-1) })); },
      create: async (path: string, content: string) => { files.set(path, content); },
    },
  } as unknown as App;
  const executor = createToolExecutor(app, { limitVaultToolScope: true, vaultToolAllowedFolders: ["Study"] });
  const call = (mode: VaultToolMode, folder: string) =>
    getVaultToolExecutionBlock("create_note", mode) ?? executor("create_note", { name: "sample", folder, content: "synthetic" });
  return { files, call };
}

describe("chat vault-tool creation with folder scope", () => {
  it("creates within an allowed folder, and rejects other folders or read-only mode", async () => {
    const vault = syntheticVault(["Study", "Outside"]);
    expect(await vault.call("all", "Study")).toMatchObject({ success: true, path: "Study/sample.md" });
    expect(await vault.call("all", "Outside")).toMatchObject({ success: false, allowedFolders: ["Study"] });
    expect(await vault.call("readOnly", "Study")).toHaveProperty("error");
    expect([...vault.files.keys()]).toEqual(["Study/sample.md"]);
  });

  it("does not let a same-named folder outside the allowed scope receive a new note", async () => {
    const vault = syntheticVault(["Outside/Study"]);
    expect(await vault.call("all", "Study")).toMatchObject({ success: false, allowedFolders: ["Study"] });
    expect([...vault.files.keys()]).toEqual([]);
  });

  it("allows an existing nested destination that is actually within the allowed scope", async () => {
    const vault = syntheticVault(["Study/Chapter"]);
    expect(await vault.call("all", "Study/Chapter")).toMatchObject({ success: true, path: "Study/Chapter/sample.md" });
    expect([...vault.files.keys()]).toEqual(["Study/Chapter/sample.md"]);
  });
});
