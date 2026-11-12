import { beforeEach, expect, it, vi } from 'vitest';

// Minimal DOM/Obsidian surface; section rendering and Provider save callbacks
// remain real. No provider verification or remote request runs in these tests.
const ui = vi.hoisted(() => ({ modals: [] as any[] }));
class Element {
  children: Element[] = []; listeners = new Map<string, () => void>();
  textContent = ''; value = ''; type = ''; scrollTop = 0; isConnected = true;
  ownerDocument = { activeElement: null }; tagName: string;
  constructor(tag = 'div', text = '') { this.tagName = tag; this.textContent = text; }
  empty() { this.children = []; } addClass() {} toggleClass() {}
  createEl(tag: string, options: any = {}) { const child = new Element(tag, options.text); child.type = options.type; this.children.push(child); return child; }
  createDiv(options: any = {}) { return this.createEl('div', options); }
  createSpan(options: any = {}) { return this.createEl('span', options); }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn); }
  querySelectorAll() { return []; } closest() { return null; }
}
vi.mock('obsidian', async original => {
  const actual = await original<typeof import('obsidian')>();
  class Control {
    inputEl = new Element('input'); click?: () => Promise<void> | void; change?: (v: string) => void;
    constructor(readonly root: Element) { root.children.push(this.inputEl); }
    setButtonText(v: string) { this.inputEl.textContent = v; return this; }
    setValue(v: string) { this.inputEl.value = v; return this; }
    onChange(fn: (v: string) => void) { this.change = fn; (this.inputEl as any).change = fn; return this; }
    onClick(fn: () => void) { this.click = fn; (this.inputEl as any).click = fn; return this; }
    setPlaceholder() { return this; } setDisabled() { return this; } addOption() { return this; }
    setCta() { return this; } setIcon() { return this; } setTooltip() { return this; }
  }
  class Setting {
    settingEl: Element; controlEl: Element;
    constructor(root: Element) { this.settingEl = root.createDiv(); this.controlEl = this.settingEl.createDiv(); }
    setName(v: string) { this.settingEl.textContent = v; return this; }
    setDesc() { return this; } setHeading() { return this; }
    addText(fn: (c: Control) => void) { fn(new Control(this.controlEl)); return this; }
    addDropdown(fn: (c: Control) => void) { fn(new Control(this.controlEl)); return this; }
    addToggle(fn: (c: Control) => void) { fn(new Control(this.controlEl)); return this; }
    addButton(fn: (c: Control) => void) { fn(new Control(this.controlEl)); return this; }
    addExtraButton(fn: (c: Control) => void) { fn(new Control(this.controlEl)); return this; }
  }
  return { ...actual, Setting,
    PluginSettingTab: class { constructor(readonly app: unknown) {} },
    Modal: class {
      contentEl = new Element(); title = ''; onOpen() {} onClose() {}
      constructor(readonly app: unknown) { ui.modals.push(this); }
      setTitle(v: string) { this.title = v; return this; }
      open() { this.onOpen(); } close() { this.onClose(); this.contentEl.isConnected = false; }
    },
  };
});
vi.mock('src/i18n', () => ({ t: (key: string) => key, getLocale: () => 'zh-CN' }));
vi.mock('./components/CliTerminalPanel', () => ({ default: () => null, isTerminalProvider: () => false }));
import { SettingsTab } from './SettingsTab';
function all(root: Element): Element[] { return [root, ...root.children.flatMap(all)]; }
function fixture() {
  const listeners = new Set<() => void>();
  const provider = { id: 'mock', type: 'custom', name: 'Before', baseUrl: 'https://example.invalid', apiKey: 'synthetic', enabledModels: ['synthetic'], availableModels: ['synthetic'], verified: true, enabled: true };
  const plugin = { app: {}, credentialConfiguredElsewhere: () => false, settings: { apiProviders: [provider], settingsAppearance: { heroCollapsed: true } },
    settingsEmitter: { on: (_: string, fn: () => void) => listeners.add(fn), off: (_: string, fn: () => void) => listeners.delete(fn) }, saveSettings: vi.fn().mockResolvedValue(undefined) } as any;
  const tab = new SettingsTab(plugin.app, plugin);
  return { tab, plugin, listeners };
}
beforeEach(() => { ui.modals = []; });
it.each(['wiki', 'search'])('refreshes the %s Provider modal after saving an edit and releases it on close', async entry => {
  const f = fixture();
  if (entry === 'wiki') f.tab.openSection('api');
  else {
    const home = new Element(); const definition = f.tab.getSettingDefinitions()[0] as any;
    definition.render({ settingEl: home });
    const input = all(home).find(el => el.type === 'text')!; input.value = 'API provider'; input.listeners.get('input')!();
    const open = all(home).find(el => el.textContent === '打开') as any; open.click();
  }
  const modal = ui.modals.at(-1)!;
  expect(all(modal.contentEl).some(el => el.textContent === 'Before (synthetic)')).toBe(true);
  // Open the real Provider editor's edit button and save a different name.
  const providerRow = modal.contentEl.children.find((el: Element) => el.textContent === 'Before (synthetic)')!;
  await (providerRow.children[0].children[2] as any).click();
  const editor = ui.modals.at(-1)!;
  const nameRow = editor.contentEl.children.find((el: Element) => el.textContent === 'settings.apiProviderName')!;
  (nameRow.children[0].children[0] as any).change('After');
  await (all(editor.contentEl).find(el => el.textContent === 'common.save') as any).click();
  expect(f.plugin.settings.apiProviders[0].name).toBe('After');
  expect(all(modal.contentEl).some(el => el.textContent === 'After (synthetic)')).toBe(true);
  f.plugin.settings.apiProviders.push({ ...f.plugin.settings.apiProviders[0], id: 'second', name: 'Added' });
  for (const listener of f.listeners) listener();
  expect(all(modal.contentEl).some(el => el.textContent === 'Added (synthetic)')).toBe(true);
  modal.close(); expect(f.listeners.size).toBe(0);
});
it('refreshes two open instances of one section independently while the settings page hides', () => {
  const f = fixture(); const definitions = f.tab.getSettingDefinitions() as any[];
  const page = new Element(); const unmountPage = definitions[1].items[0].items[0].render({ settingEl: page });
  f.tab.openSection('api'); const first = ui.modals.at(-1)!;
  f.tab.openSection('api'); const second = ui.modals.at(-1)!;
  f.tab.hide(); unmountPage(); expect(f.listeners.size).toBe(1);
  f.plugin.settings.apiProviders[0].name = 'Both';
  for (const listener of f.listeners) listener();
  expect(all(first.contentEl).some(el => el.textContent === 'Both (synthetic)')).toBe(true);
  expect(all(second.contentEl).some(el => el.textContent === 'Both (synthetic)')).toBe(true);
  first.close(); expect(f.listeners.size).toBe(1);
  f.plugin.settings.apiProviders[0].name = 'Remaining';
  for (const listener of f.listeners) listener();
  expect(all(second.contentEl).some(el => el.textContent === 'Remaining (synthetic)')).toBe(true);
  second.close(); expect(f.listeners.size).toBe(0);
});
