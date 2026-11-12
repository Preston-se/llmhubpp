import { Modal, Notice, Setting } from 'obsidian';
import type { LlmHubPlugin } from '../../plugin';
import { exportConfigurationBundle, inspectConfigurationBundle, type BundleInspection } from '../../configuration/bundle/codec';
import { previewConfigurationImport, type ImportChoices } from '../../configuration/bundle/import';
import { ConfigurationError, type ConfigPreview, type ConfigDomain } from '../../configuration/types';
import { configurationError } from '../../configuration/errors';
const MODULES: Record<ConfigDomain, string> = { settings: '模型、界面、目录与扩展', workspace: '知识库与对话偏好', safeGuard: 'Safe Guard', hotkeys: '本插件快捷键', resources: '自定义工作流、脚本与 Skills' };
export class ConfigurationTransferModal extends Modal {
    constructor(private plugin: LlmHubPlugin) { super(plugin.app); plugin.configuration?.trackModal(this); }
    onOpen(): void {
        this.setTitle('配置导入 / 导出');
        const config = this.plugin.configuration;
        if (!config) {
            this.contentEl.setText('配置服务正在准备。');
            return;
        }
        const selected = new Set(Object.keys(MODULES).filter(k => k !== 'resources')), root = this.contentEl;
        let password = '', resourcePaths = '', mappings = '{}', conflicts = '{}';
        let bundle: BundleInspection | undefined, preview: ConfigPreview | undefined;
        root.createEl('p', { text: '升级前保存配置，升级后按模块合并恢复。资料正文、聊天、索引和本次智能体授权不进入配置包。' });
        for (const [id, label] of Object.entries(MODULES))
            new Setting(root).setName(label).addToggle(t => t.setValue(selected.has(id)).onChange(on => { if (on)
                selected.add(id);
            else
                selected.delete(id); preview = undefined; }));
        new Setting(root).setName('携带凭据的口令（可选）').setDesc('留空则不导出密钥；填写后凭据以加密形式携带。导入加密包时在此输入原口令。').addText(t => { t.inputEl.type = 'password'; t.inputEl.autocomplete = 'new-password'; t.onChange(v => { password = v; preview = undefined; }); });
        new Setting(root).setName('自定义资源路径').setDesc('每行填一个库内配置文件路径。自定义文件可能内含凭据，携带文件时必须填写加密口令；只读取所选的工作流、工具与技能文件。').addTextArea(t => t.onChange(v => { resourcePaths = v; preview = undefined; }));
        const status = root.createEl('pre', { cls: 'llmhubpp-config-preview' });
        new Setting(root).setName('导出当前配置').addButton(b => b.setButtonText('导出配置包').setCta().onClick(() => {
            void (async () => {
                b.setDisabled(true);
                try {
                    const raw = await config.exportRaw(), paths = resourcePaths.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
                    raw.resources.files = {};
                    if (selected.has('resources'))
                        for (const path of paths) {
                            config.assertResourcePath(path);
                            (raw.resources.files as Record<string, string>)[path] = await this.app.vault.adapter.read(path);
                        }
                    const bytes = await exportConfigurationBundle(raw, { version: this.plugin.manifest.version, modules: [...selected], includeResources: selected.has('resources'), resourcePaths: paths, password: password || undefined });
                    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' })), link = root.createEl('a', { attr: { href: url, download: `llmhubpp-${this.plugin.manifest.version}.llmhubpp-config.zip` } });
                    link.click();
                    link.remove();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                    status.setText('配置包已生成。未提供口令时不含凭据；请保存到自己的备份位置。');
                }
                catch (e) {
                    if (e instanceof ConfigurationError) {
                        const error = configurationError(e);
                        status.setText(String(error.message) + '\n' + String(error.hint));
                    } else status.setText(e instanceof Error ? e.message : '导出失败');
                }
                finally {
                    b.setDisabled(false);
                }
            })();
        }));
        new Setting(root).setName('路径映射').setDesc('跨设备导入时填写 JSON，例如 {"C:\\old\\tool.exe":"D:\\tools\\tool.exe"}。').addTextArea(t => t.setValue('{}').onChange(v => { mappings = v; preview = undefined; }));
        new Setting(root).setName('资源冲突处理').setDesc('JSON：原路径对应 "keep" 保留现有，或填写新的库内路径另存。不会自动覆盖同名文件。').addTextArea(t => t.setValue('{}').onChange(v => { conflicts = v; preview = undefined; }));
        const file = root.createEl('input', { type: 'file', attr: { accept: '.zip,.llmhubpp-config.zip', 'aria-label': '选择配置包' } });
        file.addEventListener('change', () => { void (async () => { preview = undefined; bundle = undefined; const chosen = file.files?.[0]; if (!chosen)
            return; if (chosen.size > 20 * 1024 * 1024) {
            status.setText('配置包超过 20 MiB。');
            return;
        } try {
            bundle = await inspectConfigurationBundle(new Uint8Array(await chosen.arrayBuffer()));
            status.setText(`配置包版本：${bundle.manifest.version}\n模块：${bundle.manifest.modules.join(', ')}\n凭据槽位：${bundle.missingCredentials.length}\n${bundle.credentials ? '含加密内容，请先在此窗口输入原口令；未解锁不会生成部分导入预览。' : '请预览差异后应用。'}`);
        }
        catch (e) {
            status.setText(e instanceof Error ? e.message : '配置包无效');
        } })(); });
        new Setting(root).setName('合并导入').addButton(b => b.setButtonText('预览导入').onClick(() => { void (async () => { if (!bundle) {
            new Notice('请先选择配置包。');
            return;
        } b.setDisabled(true); try {
            const choices: ImportChoices = { modules: [...selected], pathMappings: JSON.parse(mappings) as Record<string, string>, resourceConflicts: JSON.parse(conflicts) as Record<string, string>, password };
            preview = await previewConfigurationImport(config.service, await config.prepareImport(bundle, choices), bundle, choices);
            status.setText(JSON.stringify({ changes: preview.changes,risks:preview.risks,warnings:preview.warnings, issues: preview.issues, reloadRequired: preview.reloadRequired }, null, 2));
        }
        catch (e) {
            preview = undefined;
            if (e instanceof ConfigurationError) {
                const error = configurationError(e);
                status.setText(String(error.message) + '\n' + String(error.hint));
            } else status.setText(e instanceof Error ? e.message : '预览失败');
        }
        finally {
            b.setDisabled(false);
        } })(); })).addButton(b => b.setButtonText('应用导入').setCta().onClick(() => { void (async () => { if (!preview) {
            new Notice('请先预览导入。');
            return;
        } b.setDisabled(true); try {
            const result = await config.service.apply({ previewId: preview.id, baseRevision: preview.baseRevision, requestId: crypto.randomUUID(),confirmToken:preview.confirmation?.token });
            preview = undefined;
            status.setText('导入结果：' + result.status + '\n' + JSON.stringify(result.issues));
            new Notice('配置已处理：' + result.status);
        }
        catch (e) {
            status.setText(e instanceof Error ? e.message : '导入失败');
        }
        finally {
            b.setDisabled(false);
        } })(); }));
    }
}
