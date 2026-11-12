import { TFile, TFolder, type Plugin, type TAbstractFile } from "obsidian";

type VaultIndexChange = "create" | "modify" | "rename" | "delete";

interface VaultIndexCallbacks {
  initialize(): Promise<void>;
  dispose(): void;
  managedDirectories(): readonly string[];
  changed(kind: VaultIndexChange, path: string, oldPath?: string): Promise<void>;
  onError(error: unknown): void;
}

/** Recover before listening. Register disposal before the await so an unload can interrupt setup. */
export async function registerVaultIndexEvents(
  plugin: Pick<Plugin, "app" | "register" | "registerEvent">,
  callbacks: VaultIndexCallbacks,
): Promise<boolean> {
  let active = true;
  plugin.register(() => {
    active = false;
    callbacks.dispose();
  });
  await callbacks.initialize();
  if (!active) return false;

  const { vault } = plugin.app;
  const dispatch = (kind: VaultIndexChange, file: TAbstractFile, oldPath?: string) => {
    if (!active) return;
    const directories = callbacks.managedDirectories();
    const managed = (path: string) => directories.some(directory =>
      directory && (path === directory || path.startsWith(directory + "/")));

    const visit = (item: TAbstractFile, previousPath?: string) => {
      if (managed(item.path) && (!previousPath || managed(previousPath))) return;
      if (item instanceof TFile) {
        void callbacks.changed(kind, item.path, previousPath).catch(error => callbacks.onError(error));
      } else if (item instanceof TFolder) {
        // Obsidian reports the parent move. The queue needs each child's previous path.
        for (const child of item.children) {
          visit(child, previousPath ? previousPath + child.path.slice(item.path.length) : undefined);
        }
      }
    };
    visit(file, oldPath);
  };

  plugin.registerEvent(vault.on("create", file => dispatch("create", file)));
  plugin.registerEvent(vault.on("modify", file => dispatch("modify", file)));
  plugin.registerEvent(vault.on("rename", (file, oldPath) => dispatch("rename", file, oldPath)));
  plugin.registerEvent(vault.on("delete", file => dispatch("delete", file)));
  return true;
}
