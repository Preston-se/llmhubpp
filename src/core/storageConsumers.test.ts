import { expect, it, vi } from "vitest";
vi.mock("src/ui/CliTerminalView", () => ({ CliTerminalView: class {}, CLI_TERMINAL_VIEW_TYPE: "terminal" }));
vi.mock("src/ui/components/CliTerminalPanel", () => ({ default: () => null, isTerminalProvider: () => false }));
vi.mock("src/ui/SettingsTab", () => ({ SettingsTab: class {} }));
vi.mock("obsidian", async importOriginal => ({ ...await importOriginal<typeof import("obsidian")>(), Plugin: class {} }));
import { memoryVault } from "./testSupport/memoryVault";
import { LlmHubPlugin } from "src/plugin";
import { DEFAULT_SETTINGS, DEFAULT_RAG_SETTING } from "src/types";
import { createStorageLayout } from "./storagePaths";
import { WorkspaceStateManager } from "./workspaceStateManager";
import { EventEmitter } from "src/utils/EventEmitter";
import { ChatView } from "src/ui/ChatView";

it("drops an older full-source preparation when a newer reading action has already opened", async () => {
  const m = memoryVault(); m.files.set("A.txt", "A");
  let release!: (value: string) => void;
  m.app.vault.adapter.read = async () => new Promise<string>(resolve => { release = resolve; });
  const calls: string[] = [];
  const plugin = Object.assign(Object.create(LlmHubPlugin.prototype), { app: m.app, settingsEmitter: new EventEmitter() });
  const view = new ChatView({} as never, plugin);
  (view as any).tabContainerRef = { searchReading: (context: any) => calls.push("search:" + context.filePath), askReading: (context: any) => calls.push("ask:" + context.filePath) };
  (m.app as any).workspace = { getLeavesOfType: () => [{ view }], revealLeaf: async () => undefined };
  const pending = plugin.openReadingAction({ filePath: "A.txt", selection: "" }, "current");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await plugin.openReadingAction({ filePath: "B.md", selection: "B" }, "search");
  release("A 的整篇资料"); await pending;
  expect(calls).toEqual(["search:B.md"]);
});

it("saves existing knowledge-base configuration at a newly selected inherited state location before switching settings", async () => {
  const m = memoryVault(); m.files.set("Old/gemini-workspace.json", "old-state-kept");
  const layout = createStorageLayout(null, m.app.vault.configDir); layout.root = "New";
  const settings = { ...DEFAULT_SETTINGS, storageLayout: layout, workspaceFolder: "Old" };
  const manager = new WorkspaceStateManager(m.app, () => settings, new EventEmitter(), async () => null);
  manager.workspaceState.ragSettings.User = { ...DEFAULT_RAG_SETTING, embeddingModel: "user-model" };
  const plugin = { app: m.app, settings, storageStatePath: "Old", wsManager: manager, isSecretCredentialStorage: () => false,
    saveData: async (data: unknown) => { m.files.set("saved-settings", JSON.stringify(data)); }, settingsEmitter: new EventEmitter(), initializeClients: vi.fn(), registerWorkflowHotkeys: vi.fn() };
  await LlmHubPlugin.prototype.saveSettings.call(plugin as never);
  expect(JSON.parse(m.files.get("New/gemini-workspace.json") as string).ragSettings.User.embeddingModel).toBe("user-model");
  expect(m.files.get("Old/gemini-workspace.json")).toBe("old-state-kept");
  expect(JSON.parse(m.files.get("saved-settings") as string).workspaceFolder).toBe("New");
});
