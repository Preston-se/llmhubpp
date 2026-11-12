import { Modal, Notice, Setting, type TextAreaComponent } from 'obsidian';
import type { LlmHubPlugin } from '../../plugin';
import type { ConfigDomain, ConfigPreview } from '../../configuration/types';
export class ConfigurationEditorModal extends Modal {
    constructor(private plugin: LlmHubPlugin, private moduleId: ConfigDomain = 'settings') { super(plugin.app); plugin.configuration?.trackModal(this); }
    onOpen(): void { this.setTitle('精细配置'); void this.render(); }
    private async render(): Promise<void> {
        const config = this.plugin.configuration;
        if (!config) {
            this.contentEl.setText('配置服务正在准备，请稍后重试。');
            return;
        }
        const root = this.contentEl;
        root.empty();
        new Setting(root).setName('配置模块').addDropdown(d => { for (const id of ['settings', 'workspace', 'safeGuard', 'hotkeys', 'resources'])
            d.addOption(id, id); d.setValue(this.moduleId).onChange(id => { this.moduleId = id as ConfigDomain; void this.render(); }); });
        const snapshot = await config.service.read();
        let field = config.service.describe([this.moduleId]).find(d => !d.readOnly)?.fieldId ?? '';
        let input = '';
        let preview: ConfigPreview | undefined;
        let areaRef: TextAreaComponent;
        new Setting(root).setName('字段').addDropdown(drop => { for (const d of config.service.describe([this.moduleId]).filter(d => !d.readOnly))
            drop.addOption(d.fieldId, d.description); drop.setValue(field).onChange(v => { field = v; preview = undefined; input = JSON.stringify(snapshot.modules[this.moduleId][field] ?? null, null, 2); areaRef.setValue(input); }); });
        const desc = root.createDiv({ cls: 'setting-item-description' });
        desc.setText('用 JSON 调整字段；集合按稳定 ID 合并。密钥状态不可当作实际值提交，请改用原设置页输入。');
        new Setting(root).setName('配置值').addTextArea(area => { areaRef = area; area.inputEl.addClass('llmhubpp-config-json'); input = JSON.stringify(snapshot.modules[this.moduleId][field] ?? null, null, 2); area.setValue(input).onChange(v => { input = v; preview = undefined; }); });
        const status = root.createEl('pre', { cls: 'llmhubpp-config-preview' });
        new Setting(root).setName('应用前检查').addButton(b => b.setButtonText('预览差异').onClick(() => { void (async () => { try {
            preview = await config.service.preview({ baseRevision: snapshot.revision, operations: [{ op: 'update', moduleId: this.moduleId, fieldId: field, value: JSON.parse(input) as unknown }] });
            status.setText(JSON.stringify({changes:preview.changes,risks:preview.risks,issues:preview.issues,warnings:preview.warnings}, null, 2));
        }
        catch (e) {
            status.setText(e instanceof Error ? e.message : '预览失败');
        } })(); })).addButton(b => b.setButtonText('应用').setCta().onClick(() => { void (async () => { if (!preview) {
            new Notice('请先预览差异。');
            return;
        } b.setDisabled(true); try {
            const result = await config.service.apply({ previewId: preview.id, baseRevision: preview.baseRevision, requestId: crypto.randomUUID(),confirmToken:preview.confirmation?.token });
            new Notice('配置结果：' + result.status);
            await this.render();
        }
        catch (e) {
            status.setText(e instanceof Error ? e.message : '应用失败');
            b.setDisabled(false);
        } })(); }));
    }
}
