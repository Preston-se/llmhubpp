import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmHubPlugin } from "src/plugin";
import type { SettingsContext } from "./settingsContext";

const h = vi.hoisted(() => ({ settings: [] as any[], checkboxes: [] as any[], modal: null as any, verify: vi.fn(), notices: [] as string[] }));

vi.mock("obsidian", () => {
  class Element {
    checked = false; events: Record<string, () => void> = {}; value = ""; textContent = "";
    addClass() {} removeClass() {} empty() {} toggleClass() {}
    createDiv() { return new Element(); }
    createSpan() { return new Element(); }
    createEl(tag: string, options: { type?: string } = {}) {
      const el = new Element();
      if (tag === "input" && options.type === "checkbox") h.checkboxes.push(el);
      return el;
    }
    addEventListener(event: string, fn: () => void) { this.events[event] = fn; }
  }
  class Control {
    inputEl = new Element(); buttonEl = new Element(); type = ""; icon = ""; value = ""; text = "";
    click: (...args: any[]) => any = () => {}; change: (...args: any[]) => any = () => {};
    setIcon(v: string) { this.icon = v; return this; } setTooltip() { return this; }
    setButtonText(v: string) { this.text = v; return this; } setCta() { return this; } setDisabled() { return this; }
    setValue(v: string) { this.value = v; return this; } setPlaceholder() { return this; } addOption() { return this; }
    onClick(fn: (...args: any[]) => any) { this.click = fn; return this; }
    onChange(fn: (...args: any[]) => any) { this.change = fn; return this; }
  }
  class Setting {
    settingEl = new Element(); controlEl = new Element(); controls: Control[] = []; name = "";
    constructor() { h.settings.push(this); }
    setName(v: string) { this.name = v; return this; } setDesc() { return this; } setHeading() { return this; }
    add(fn: (c: Control) => void, type: string) { const c = new Control(); c.type = type; this.controls.push(c); fn(c); return this; }
    addToggle(fn: (c: Control) => void) { return this.add(fn, "toggle"); }
    addExtraButton(fn: (c: Control) => void) { return this.add(fn, "extra"); }
    addButton(fn: (c: Control) => void) { return this.add(fn, "button"); }
    addDropdown(fn: (c: Control) => void) { return this.add(fn, "dropdown"); }
    addText(fn: (c: Control) => void) { return this.add(fn, "text"); }
  }
  class Modal {
    contentEl = new Element();
    constructor(_app: unknown) {}
    open() { h.modal = this; (this as any).onOpen(); }
    close() { (this as any).onClose(); h.modal = null; }
  }
  return { Setting, Modal, Notice: class { constructor(message: string) { h.notices.push(message); } }, Platform: { isMobile: false } };
});
vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("src/types", () => ({ KNOWN_PROVIDER_DEFAULTS: {}, normalizeDeprecatedGeminiModelName: (s: string) => s }));
vi.mock("src/core/openaiProvider", () => ({ verifyApiProvider: h.verify, verifyOpencodeGo: h.verify }));
vi.mock("src/core/anthropicProvider", () => ({ verifyAnthropicProvider: h.verify }));
vi.mock("src/core/gemini", () => ({ verifyGeminiProvider: h.verify }));
vi.mock("src/core/modelPricing", () => ({ getKnownModels: () => ["mock-a", "mock-b"] }));
vi.mock("src/core/credentialBundle", () => ({ credentialSlot: { apiProvider: () => "placeholder" } }));
vi.mock("./credentialStorageSettings", () => ({ markCredentialConfiguredElsewhere: () => {} }));

import { displayApiProviderSettings } from "./apiProviderSettings";

function openEditor() {
  const provider = { id: "fixture", name: "Synthetic", type: "custom", baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "placeholder", enabledModels: ["mock-a"], availableModels: ["mock-a", "mock-b"], verified: true, enabled: true };
  const plugin = { settings: { apiProviders: [provider] }, app: {}, saveSettings: vi.fn() };
  displayApiProviderSettings({} as HTMLElement, { plugin, display: () => {} } as unknown as SettingsContext);
  const row = h.settings.find(setting => setting.name === "Synthetic (mock-a)");
  row.controls.find((control: any) => control.icon === "settings").click();
  return { provider, plugin: plugin as unknown as LlmHubPlugin };
}

function control(settingName: string, type: string) {
  return h.settings.findLast(setting => setting.name === settingName).controls.find((item: any) => item.type === type);
}

function verifyButton() {
  return h.settings.flatMap(setting => setting.controls).findLast((item: any) => item.text === "settings.apiProviderVerify");
}

beforeEach(() => { h.settings = []; h.checkboxes = []; h.modal = null; h.notices = []; h.verify.mockReset(); });

describe("provider settings draft", () => {
  it("does not mutate the saved model list when a modal is closed without saving", () => {
    const { provider, plugin } = openEditor();
    h.checkboxes[1].checked = true; h.checkboxes[1].events.change();
    h.modal.close();
    expect(provider.enabledModels).toEqual(["mock-a"]);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("invalidates a previous verification after the endpoint or key changes", () => {
    openEditor();
    control("settings.apiProviderBaseUrl", "text").change("http://127.0.0.1:2/v1");
    expect(h.modal.config.verified).toBe(false);
  });

  it("invalidates verification on key or provider type changes but not on PDF display preference", () => {
    openEditor();
    control("settings.pdfInputMode", "dropdown").change("extract-text");
    expect(h.modal.config.verified).toBe(true);
    control("settings.apiProviderApiKey", "text").change("different-placeholder");
    expect(h.modal.config.verified).toBe(false);
    h.modal.config.verified = true;
    control("settings.apiProviderType", "dropdown").change("anthropic");
    expect(h.modal.config.verified).toBe(false);
  });

  it("discards a verification response if the endpoint changed while the request was running", async () => {
    let resolve!: (value: unknown) => void;
    h.verify.mockImplementation(() => new Promise(r => { resolve = r; }));
    openEditor(); const pending = verifyButton().click();
    control("settings.apiProviderBaseUrl", "text").change("http://127.0.0.1:2/v1");
    resolve({ success: true, models: ["mock-b"] }); await pending;
    expect(h.modal.config.verified).toBe(false);
    expect(h.modal.config.enabledModels).toEqual(["mock-a"]);
  });

  it("clears a prior verified flag on failure and preserves selected models on success", async () => {
    h.verify.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true, models: ["mock-b"] });
    openEditor(); await verifyButton().click();
    expect(h.modal.config.verified).toBe(false);
    await verifyButton().click();
    expect(h.modal.config.verified).toBe(true);
    expect(h.modal.config.enabledModels).toEqual(["mock-a"]);
  });

  it("does not save or notify after a pending verification dialog is closed", async () => {
    let resolve!: (value: unknown) => void;
    h.verify.mockImplementation(() => new Promise(r => { resolve = r; }));
    const { provider, plugin } = openEditor(); const pending = verifyButton().click();
    h.modal.close(); resolve({ success: true, models: ["mock-b"] }); await pending;
    expect(provider.enabledModels).toEqual(["mock-a"]);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(h.notices).toEqual([]);
  });

  it("saves an explicitly selected model when the user confirms", async () => {
    const { plugin } = openEditor();
    h.checkboxes[1].checked = true; h.checkboxes[1].events.change();
    const save = h.settings.flatMap(setting => setting.controls).findLast((item: any) => item.text === "common.save");
    await save.click();
    expect(plugin.settings.apiProviders[0].enabledModels).toEqual(["mock-a", "mock-b"]);
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
  });
});
