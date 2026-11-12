import type { DataAdapter } from "obsidian";
export const STORAGE_FOLDERS = ["tools", "skills", "rag", "chats", "exports", "state", "tasks", "sources"] as const;
export type StorageFolder = typeof STORAGE_FOLDERS[number];
export interface StorageLayout { version: 1; root: string; overrides: Partial<Record<StorageFolder, string>>; legacy?: boolean }
interface SavedStorage { storageLayout?: StorageLayout; workspaceFolder?: string; skillsFolder?: string; skillsFolderPath?: string; manualChatSaveFolder?: string }
export interface StoragePaths extends Record<StorageFolder, string> { workspace: string }
const CHILDREN: Record<StorageFolder, string> = { tools: "tools", skills: "skills", rag: "rag", chats: "", exports: "", state: "", tasks: "tasks", sources: "sources" };
export function normalizeStoragePath(path: string, allowRoot = false): string {
  const value = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if ((!allowRoot && !value) || /^(?:[a-z]:|\/)/i.test(value) || value.split("/").some(part => part === "." || part === "..") || /[<>:"|?*]/.test(value) || Array.from(value).some(character => character.charCodeAt(0) < 32)) throw new Error("invalid-storage-path");
  return value;
}
export function createStorageLayout(saved: SavedStorage | null, configDir = ""): StorageLayout {
  if (saved?.storageLayout) return { ...saved.storageLayout, overrides: { ...saved.storageLayout.overrides } };
  const root = saved?.workspaceFolder?.trim() || "LLMHub";
  if (saved === null) return { version: 1, root, overrides: {} };
  // An empty object is still an old install, whose omitted skills default was vault-root/skills.
  return { version: 1, root, legacy: true, overrides: {
    tools: `${root}/tools`, skills: saved.skillsFolder || saved.skillsFolderPath || "skills", rag: `${root}/rag`,
    chats: root, exports: saved.manualChatSaveFolder || "", state: root,
    tasks: [configDir, "llmhubpp-task-journal"].filter(Boolean).join("/"), sources: [configDir, "llmhubpp-sources"].filter(Boolean).join("/"),
  } };
}
export function resolveStoragePaths(saved: SavedStorage | null, configDir = ""): StoragePaths {
  const layout = createStorageLayout(saved, configDir);
  if (layout.version !== 1) throw new Error("invalid-storage-layout");
  const root = normalizeStoragePath(layout.root);
  const entries = STORAGE_FOLDERS.map(key => {
    const custom = layout.overrides[key];
    return [key, custom !== undefined ? normalizeStoragePath(custom, key === "exports") : [root, CHILDREN[key]].filter(Boolean).join("/")];
  });
  return { workspace: root, ...Object.fromEntries(entries) } as StoragePaths;
}
export function getStoragePaths(settings: SavedStorage, configDir = ""): StoragePaths { return resolveStoragePaths(settings, configDir); }
export function managedStorageDirectories(paths: StoragePaths): string[] { return [paths.workspace, ...STORAGE_FOLDERS.map(key => paths[key])].filter(Boolean); }

/** Old manual exports may be at vault root, which cannot be excluded wholesale.
 * Recognize the shared writer's filename AND compact-chat serialization there. */
export function isManagedRootExport(io: DataAdapter, paths: StoragePaths, path: string): boolean | Promise<boolean> {
  if (paths.exports !== "" || !/^\d{8}-\d{6}_[^/]+\.md$/.test(path)) return false;
  return io.read(path).then(text => /^## You\r?\n\r?\n/.test(text), () => false);
}

/** Storage can be selected without moving existing files or widening model tool access. */
export function applyStoragePaths<T extends SavedStorage>(settings: T, configDir = ""): StoragePaths {
  const paths = getStoragePaths(settings, configDir);
  settings.workspaceFolder = paths.workspace; settings.skillsFolder = paths.skills; settings.manualChatSaveFolder = paths.exports;
  return paths;
}
export async function ensureStorageDirectory(io: DataAdapter, path: string): Promise<void> {
  const parts = normalizeStoragePath(path).split("/");
  for (let i = 1; i <= parts.length; i++) {
    const directory = parts.slice(0, i).join("/");
    if (!await io.exists(directory)) {
      try { await io.mkdir(directory); } catch (error) { if (!await io.exists(directory)) throw error; }
    }
  }
}
