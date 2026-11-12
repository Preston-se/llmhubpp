import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ descriptions: [] as string[], notices: [] as string[], confirmation: "", buttons: [] as any[], nextCommit: "same" }));
vi.mock("obsidian", () => ({ Setting: class {
  setName() { return this; } setHeading() { return this; } setDesc(value: string) { h.descriptions.push(value); return this; }
  addText() { return this; } addToggle() { return this; }
  addButton(fn: (button: any) => void) { return this.addExtraButton(fn); }
  addExtraButton(fn: (button: any) => void) {
    const button = { tooltip: "", action: () => {}, setIcon() { return this; }, setCta() { return this; }, setDisabled() { return this; },
      setButtonText() { return this; }, setTooltip(text: string) { this.tooltip = text; return this; }, onClick(action: () => void) { this.action = action; return this; } };
    h.buttons.push(button); fn(button); return this;
  }
}, Notice: class { constructor(text: string) { h.notices.push(text); } } }));
vi.mock("src/core/mcpTools", () => ({ clearMcpToolsCache: () => {} }));
vi.mock("src/core/agentPlugins", () => ({ previewAgentPlugin: async () => ({ commitSha: h.nextCommit, version: "2" }), uninstallAgentPlugin: async () => {},
  agentPluginAbsolutePaths: () => ({}), installAgentPlugin: async () => {}, parseAgentPluginMcp: () => ({ servers: [] }) }));
vi.mock("./AgentPluginInstallModal", () => ({ AgentPluginInstallModal: class {} }));
vi.mock("src/ui/components/ConfirmModal", () => ({ ConfirmModal: class {
  constructor(_app: unknown, question: string) { h.confirmation = question; } openAndWait() { return Promise.resolve(true); }
} }));
import { displayAgentPluginSettings } from "./agentPluginSettings";
import { setLocale } from "src/i18n";

it("localizes installed extension status, update notices and uninstall confirmation/results", async () => {
  setLocale("zh"); h.buttons = []; h.notices = []; h.descriptions = [];
  const plugin = { app: {}, settings: { agentPlugins: [{ name: "Demo", version: "1", repo: "owner/repo", commitSha: "same", skillNames: [], enabled: true }], mcpServers: [] },
    saveSettings: async () => {}, settingsEmitter: { emit() {} } };
  displayAgentPluginSettings({ createDiv() {} } as never, { plugin, display() {} } as never);
  expect(h.descriptions.at(-1)).toContain("技能：无");
  h.buttons.find(button => button.tooltip === "检查更新").action(); await new Promise(resolve => setImmediate(resolve));
  expect(h.notices.at(-1)).toBe("Demo 已是最新版本。");
  h.nextCommit = "next";
  h.buttons.find(button => button.tooltip === "检查更新").action(); await new Promise(resolve => setImmediate(resolve));
  expect(h.notices.at(-1)).toContain("发现 Demo 的新版本：2");
  h.buttons.find(button => button.tooltip === "卸载").action(); await new Promise(resolve => setImmediate(resolve));
  expect(h.confirmation).toBe("卸载 Demo？");
  expect(h.notices.at(-1)).toBe("已卸载 Demo，扩展数据已保留。");
  setLocale("en");
});
