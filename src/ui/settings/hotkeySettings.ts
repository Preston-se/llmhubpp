import { settingsText as tr } from "./settingsText";
import { Modal, Notice, Setting } from 'obsidian';
import type { SettingsContext } from './settingsContext';
import type { LlmHubPlugin } from '../../plugin';
import { inspectHotkeyConflict, readEffectiveHotkeys, type HotkeyBinding } from '../../core/hotkeyConflicts';
export class HotkeyCaptureModal extends Modal {
    constructor(private plugin: LlmHubPlugin, private commandId: string, private saved: () => void) { super(plugin.app); plugin.configuration?.trackModal(this); }
    onOpen(): void {
        this.setTitle(tr("Configure hotkey", '配置快捷键'));
        let binding: HotkeyBinding | undefined;
        const input = this.contentEl.createEl('input', { attr: { readonly: 'true', 'aria-label': tr("Press the key combination", '按下快捷键组合'), placeholder: tr("Click and press a key combination", '点击后按下组合键') } }), status = this.contentEl.createDiv();
        input.focus();
        input.addEventListener('keydown', event => { event.preventDefault(); event.stopPropagation(); if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key))
            return; binding = { modifiers: [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.metaKey ? ['Meta'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : [])], key: event.key === ' ' ? 'Space' : event.key }; input.value = [...binding.modifiers, binding.key].join(' + '); const result = inspectHotkeyConflict(this.commandId, binding, readEffectiveHotkeys(this.app)); status.setText(!result.checked ? tr("Obsidian hotkeys are unavailable. Conflicts could not be checked.", '宿主快捷键信息不可用，尚未检查冲突。') : result.conflicts.length ? tr("Already assigned: ", '已被占用：') + result.conflicts.map(c => `${c.name} (${c.id})`).join('、') : tr("No conflict found in Obsidian. Check shortcuts used by the system and other apps separately.", '未发现 Obsidian 内冲突。系统及其他进程的快捷键需自行确认。')); });
        const save = async (value: HotkeyBinding[]) => {
            const service = this.plugin.configuration?.service;
            if (!service) {
                new Notice(tr("The configuration service is not ready.", '配置服务未准备。'));
                return;
            }
            const snapshot = await service.read(), bindings = snapshot.modules.hotkeys.bindings as Record<string, unknown> ?? {};
            const p = await service.preview({ baseRevision: snapshot.revision, operations: [{ op: 'set', moduleId: 'hotkeys', fieldId: 'bindings', value: { ...bindings, [this.commandId]: value } }] });
            await service.apply({ previewId: p.id, baseRevision: p.baseRevision, requestId: crypto.randomUUID() });
            this.saved();
            this.close();
        };
        new Setting(this.contentEl).setName(tr("Save shortcut", '保存绑定')).addButton(b => b.setButtonText(tr("Apply", '应用')).setCta().onClick(() => { void (async () => { if (!binding)
            return; const result = inspectHotkeyConflict(this.commandId, binding, readEffectiveHotkeys(this.app)); if (!result.checked || result.conflicts.length) {
            new Notice(tr("Resolve the conflict or open Obsidian hotkey settings.", '请先解决冲突或打开 Obsidian 快捷键设置。'));
            return;
        } try {
            await save([binding]);
        }
        catch (e) {
            new Notice(e instanceof Error ? e.message : tr("Could not save the hotkey.", '保存失败'));
        } })(); })).addButton(b => b.setButtonText(tr("Clear shortcut", '清除绑定')).onClick(() => { void save([]).catch(() => new Notice(tr("Could not clear the hotkey.", '清除失败'))); }));
    }
}
export function displayHotkeySettings(root: HTMLElement, ctx: SettingsContext): void {
    root.createEl('p', { text: tr("New commands start without shortcuts. Existing bindings are preserved. Changes are checked against Obsidian's active hotkeys.", '新命令默认不绑定。已有绑定继续保留；修改前会检测 Obsidian 当前有效快捷键。') });
    new Setting(root).setName(tr("Obsidian hotkeys", 'Obsidian 快捷键')).addButton(b => b.setButtonText(tr("Open hotkey settings", '打开快捷键设置')).onClick(() => { (ctx.plugin.app as unknown as {
        setting: {
            openTabById(id: string): void;
        };
    }).setting.openTabById('hotkeys'); }));
    const input = root.createEl('input', { attr: { placeholder: tr("Search commands", '搜索命令'), 'aria-label': tr("Search Llmhub++ commands", '搜索本插件命令') } }), list = root.createDiv();
    const render = () => { list.empty(); const snapshot = readEffectiveHotkeys(ctx.plugin.app); for (const c of Object.values(snapshot.commands).filter(c => c.id.startsWith('llmhubpp:') && (c.name + ' ' + c.id).toLowerCase().includes(input.value.toLowerCase()))) {
        const keys = snapshot.bindings[c.id] ?? [];
        new Setting(list).setName(c.name).setDesc(keys.map(k => [...k.modifiers, k.key].join('+')).join(' / ') || tr("Unassigned", '未绑定')).addButton(b => b.setButtonText(tr("Configure", '配置')).onClick(() => new HotkeyCaptureModal(ctx.plugin, c.id, render).open()));
    } };
    input.addEventListener('input', render);
    render();
}
