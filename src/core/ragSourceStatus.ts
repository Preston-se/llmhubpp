import { TFile, type App } from "obsidian";

export type SourceStatus = "available" | "missing" | "unknown";

/** Distinguish a missing vault source from an external source we cannot inspect. */
export async function getRagSourceStatus(app: App, path: string): Promise<SourceStatus> {
  try {
    if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)) {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? "available" : "missing";
    }
    const fs = (window as unknown as { require?: (id: string) => typeof import("fs") }).require?.("fs");
    if (!fs) return "unknown";
    try { return (await fs.promises.stat(path)).isFile() ? "available" : "missing"; }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "missing" : "unknown";
    }
  } catch { return "unknown"; }
}
