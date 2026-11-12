import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { McpServerConfig } from "src/types";
import { McpApprovalModal } from "./McpApprovalModal";

const { buttons, descriptions } = vi.hoisted(() => ({
  buttons: new Map<string, () => void>(), descriptions: [] as string[],
}));

vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("obsidian", () => ({
  Modal: class {
    contentEl = {
      createEl: (_tag: string, options: { text: string }) => descriptions.push(options.text),
      empty: () => {},
    };
    open() { (this as unknown as McpApprovalModal).onOpen(); }
    close() { (this as unknown as McpApprovalModal).onClose(); }
  },
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    addButton(configure: (button: object) => void) {
      let label: string;
      const button = {
        setButtonText(value: string) { label = value; return button; },
        setCta() { return button; },
        onClick(callback: () => void) { buttons.set(label, callback); return button; },
      };
      configure(button);
      return this;
    }
  },
}));

const server: McpServerConfig = {
  name: "deepseek-search", enabled: true, transport: "stdio", command: "node",
  args: ["D:\\tools\\deepseek-search-mcp.mjs"],
};

describe("MCP search authorization", () => {
  beforeEach(() => { buttons.clear(); descriptions.length = 0; });

  it("offers one persistent approval for the configured DeepSeek search", async () => {
    const modal = new McpApprovalModal({} as App, server, "deepseek_web_search", { query: "Obsidian docs" }, true);
    const decision = modal.openAndWait();
    expect(descriptions).toContain("mcp.approval.searchDetails");
    expect([...buttons.keys()]).toEqual(["mcp.approval.deny", "mcp.approval.allowSearch"]);
    buttons.get("mcp.approval.allowSearch")!();
    await expect(decision).resolves.toBe("always");
  });

  it.each([
    [server, "write_note", true],
    [{ ...server, args: ["third-party-search.mjs"] }, "deepseek_web_search", true],
    [server, "deepseek_web_search", false],
  ] as const)("keeps one-time confirmation for tools outside the saved search connection", async (config, tool, canRemember) => {
    const modal = new McpApprovalModal({} as App, config, tool, {}, canRemember);
    const decision = modal.openAndWait();
    expect(buttons.has("mcp.approval.allowSearch")).toBe(false);
    buttons.get("mcp.approval.once")!();
    await expect(decision).resolves.toBe("once");
  });
});
