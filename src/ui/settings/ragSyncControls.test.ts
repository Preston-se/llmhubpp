import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "src/core/taskManager";

const h = vi.hoisted(() => ({ buttons: [] as any[] }));
vi.mock("obsidian", () => {
  class Element {
    textContent = ""; value = 0; max = 0; classes = new Set<string>();
    addClass(name: string) { this.classes.add(name); } removeClass(name: string) { this.classes.delete(name); }
    createDiv() { return new Element(); } createEl() { return new Element(); }
  }
  class Button {
    buttonEl = new Element(); text = ""; disabled = false; click: () => void = () => {};
    setButtonText(text: string) { this.text = text; return this; } setCta() { return this; }
    setDisabled(value: boolean) { this.disabled = value; return this; } onClick(fn: () => void) { this.click = fn; return this; }
  }
  class Setting {
    setName() { return this; }
    addButton(fn: (b: Button) => void) { const b = new Button(); h.buttons.push(b); fn(b); return this; }
  }
  return { Setting, Notice: class {}, Element };
});
vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("src/core/localRagStore", () => ({ getLocalRagStore: vi.fn() }));
vi.mock("src/core/embeddingProvider", () => ({ fetchEmbeddingModels: vi.fn() }));
vi.mock("src/types", () => ({ DEFAULT_GEMINI_EMBEDDING_MODEL: "", DEFAULT_RAG_SETTING: {}, getGeminiApiKey: () => "" }));
vi.mock("src/ui/components/ConfirmModal", () => ({ ConfirmModal: class {} }));
vi.mock("obsidian-llm-hub-common/core", () => ({ formatError: (error: Error) => error.message }));
vi.mock("obsidian-llm-hub-common/obsidian", () => ({ setDestructiveButton: (button: unknown) => button }));
vi.mock("obsidian-llm-hub-common/settings", () => ({}));
vi.mock("./credentialStorageSettings", () => ({ markRagKeyConfiguredElsewhere: vi.fn() }));

import * as controls from "./ragSettings";

describe("settings sync controls", () => {
  it("cancels the same managed task immediately without requiring another progress callback", async () => {
    h.buttons = [];
    const render = (controls as unknown as { displaySyncControls?: (container: unknown, context: unknown, name: string) => void }).displaySyncControls;
    expect(render).toBeTypeOf("function");
    const tasks = new TaskManager();
    const sync = vi.fn((_name, _progress, signal: AbortSignal) => tasks.run("index", async task =>
      new Promise<void>((_resolve, reject) => task.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })))), { signal, serial: true }));
    const node = { createDiv: () => ({ addClass() {}, removeClass() {}, createDiv: () => ({ textContent: "", removeClass() {}, addClass() {} }), createEl: () => ({ addClass() {}, value: 0, max: 0 }) }) };
    render?.(node, { plugin: { syncVaultForLocalRAG: sync }, display: () => {}, syncCancelRef: { controllers: new Map() } }, "A");
    h.buttons.find(b => b.text === "settings.localSyncBtn").click();
    await new Promise(resolve => setImmediate(resolve));
    const signal = sync.mock.calls[0][2];
    expect(signal).toBeInstanceOf(AbortSignal);
    h.buttons.find(b => b.text === "settings.cancelSync").click();
    await new Promise(resolve => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    expect(tasks.list()[0].snapshot.status).toBe("cancelled");
  });

  it("retains a visible cancellation control when settings rerender during a sync", async () => {
    h.buttons = [];
    const render = (controls as unknown as { displaySyncControls: (container: unknown, context: unknown, name: string) => void }).displaySyncControls;
    const tasks = new TaskManager();
    const sync = vi.fn((_name, _progress, signal: AbortSignal) => tasks.run("index", async task =>
      new Promise<void>((_resolve, reject) => task.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })))), { signal, serial: true }));
    const node = { createDiv: () => ({ addClass() {}, removeClass() {}, createDiv: () => ({ textContent: "", removeClass() {}, addClass() {} }), createEl: () => ({ addClass() {}, value: 0, max: 0 }) }) };
    const context = { plugin: { syncVaultForLocalRAG: sync }, display: () => {}, syncCancelRef: { value: false, controllers: new Map() } };
    render(node, context, "A"); h.buttons.find(b => b.text === "settings.localSyncBtn").click();
    await new Promise(resolve => setImmediate(resolve));
    render(node, context, "A");
    const cancel = h.buttons.filter(b => b.text === "settings.cancelSync").at(-1);
    expect(cancel.buttonEl.classes.has("llm-hub-hidden")).toBe(false);
    const syncButton = h.buttons.at(-1);
    expect(syncButton.disabled).toBe(true);
    cancel.click(); await new Promise(resolve => setImmediate(resolve));
    expect(tasks.list()[0].snapshot.status).toBe("cancelled");
  });
});
