import { configurationPreviewText, configurationErrorText, configurationStatusLabel } from './configurationCopy';
import { settingsText as tr } from "./settingsText";
import { Modal, Notice, Platform, Setting } from 'obsidian';
import type { SettingsContext } from './settingsContext';
import { ConfigurationEditorModal } from './ConfigurationEditorModal';
import { HelpModal } from '../HelpModal';
import { configurationGuide } from '../../configuration/mcp/tools';
export function displayAgentConfigurationSettings(root: HTMLElement, ctx: SettingsContext): void {
    const { plugin } = ctx, configuration = plugin.configuration;
    if (Platform.isMobile) {
        root.createEl('p', { text: tr("External agent configuration is available on desktop.", '外部智能体配置服务仅在桌面端可用。') });
        return;
    }
    if (!configuration) {
        root.createEl('p', { text: tr("The configuration service is starting. See User notes for recovery help.", '配置服务正在准备；如有恢复问题，请查看用户须知。') });
        return;
    }
    if (configuration.service.recoveryRequired)
        root.createEl('p', { text: tr("The previous configuration update requires recovery. You can read and export the configuration while writes are paused. Keep configuration/pending.json and follow the troubleshooting guide.", '上次配置事务需要恢复：当前配置可查询和导出，写入已暂停。请保留 configuration/pending.json 并按故障排查指南核对。'), cls: 'mod-warning' });
    const status = root.createDiv({ cls: 'llmhubpp-agent-status' }), connection = root.createEl('textarea', { attr: { readonly: 'true', 'aria-label': tr("Agent connection details", 'Agent 接入信息') } });
    connection.addClass('llmhubpp-config-json');
    const show = () => { const s = configuration.mcp.getStatus(); status.setText(s.state === 'open' ? tr("Running · Local connections only", '已开启 · 仅限本机') : s.state === 'failed' ? tr("Could not start", '开启失败') : s.state === 'starting' ? tr("Starting", '正在开启') : tr("Stopped", '未开启')); if (s.state !== 'open')
        connection.value = ''; };
    show();
    new Setting(root).setName(tr("Configuration service", '辅助配置服务')).setDesc(tr("Start the service and give the connection details to your external agent. Start it again after closing or reloading the plugin.", '开启后，把接入信息交给你使用的外部智能体。关闭或重载插件后需重新开启。')).addButton(b => b.setButtonText(tr("Start or show connection", '开启 / 查看连接')).onClick(() => { void (async () => { b.setDisabled(true); try {
        const c = await configuration.mcp.start();
        connection.value = JSON.stringify({ mcpServers: { llmhubpp: { type: 'http', url: c.endpoint, headers: { Authorization: `Bearer ${c.token}` } } } }, null, 2);
        show();
    }
    catch {
        new Notice(tr("Could not start the local configuration service.", '本机配置服务启动失败。'));
        show();
    }
    finally {
        b.setDisabled(false);
    } })(); })).addButton(b => b.setButtonText(tr("Stop", '关闭')).onClick(() => { void configuration.mcp.stop().then(show); }));
    new Setting(root).setName(tr("Connection and access", '接入与操作')).addButton(b => b.setButtonText(tr("Copy connection details", '复制接入信息')).onClick(() => { if (connection.value)
        void navigator.clipboard.writeText(connection.value).then(() => new Notice(tr("Connection details copied. Share them only with a trusted local agent.", '已复制接入信息，请只交给你信任的本机智能体。'))); })).addButton(b => b.setButtonText(tr("Rotate token", '轮换令牌')).onClick(() => { void (async () => { if (configuration.mcp.getStatus().state !== 'open')
        return; const token = await configuration.mcp.rotateToken(); connection.value = JSON.stringify({ mcpServers: { llmhubpp: { type: 'http', url: configuration.mcp.getStatus().endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2); new Notice(tr("The previous token is no longer valid.", '旧令牌已失效。')); })(); })).addButton(b => b.setButtonText(tr("Open guide", '操作指南')).onClick(() => new HelpModal(plugin, 'mcp-agent-guide').open()));
    new Setting(root).setName(tr("Agent instructions", '智能体操作说明')).addButton(b => b.setButtonText(tr("Copy instructions", '复制操作说明')).onClick(() => { void navigator.clipboard.writeText(configurationGuide(configuration.service)).then(() => new Notice(tr("Instructions copied.", '已复制操作说明。'))); })).addButton(b => b.setButtonText(tr("Fine-grained configuration", '精细配置')).onClick(() => new ConfigurationEditorModal(plugin).open()));
    const history = root.createDiv();
    new Setting(root).setName(tr("Recent configuration changes", '最近配置变更')).addButton(b => b.setButtonText(tr("Refresh history", '刷新记录')).onClick(() => { void configuration.service.history().then(entries => { history.empty(); for (const entry of entries) {
        new Setting(history).setName(new Date(entry.time).toLocaleString() + ' · ' + configurationStatusLabel(entry.status)).setDesc(entry.changes.map(c => `${c.moduleId}.${c.fieldId}`).join('、')).addButton(button => button.setButtonText(tr("Restore", '恢复')).onClick(() => { void (async () => { button.setDisabled(true); try {
            const current = await configuration.service.read();
            const result = await configuration.service.restore({ operationId: entry.operationId, baseRevision: current.revision, requestId: crypto.randomUUID() });
            if(result.status==='confirmation-required'){
                const review=configuration.trackModal(new Modal(plugin.app));review.setTitle(tr("Review risks before restoring", '恢复前核对风险'));
                review.contentEl.createEl('p',{text:tr("This restore changes protection, permissions, or executable settings. Review the risks and differences before you confirm.", '这次恢复会改变保护、权限或可执行配置。请核对以下风险与差异，再明确选择是否恢复。')});
                review.contentEl.createEl('pre',{text:configurationPreviewText({risks:result.preview.risks,changes:result.preview.changes}),cls:'llmhubpp-config-preview'});
                new Setting(review.contentEl).addButton(b=>b.setButtonText(tr("Cancel", '取消')).onClick(()=>review.close())).addButton(b=>b.setButtonText(tr("Confirm restore", '确认恢复')).onClick(()=>{b.setDisabled(true);void configuration.service.apply({previewId:result.preview.id,baseRevision:result.preview.baseRevision,requestId:crypto.randomUUID(),confirmToken:result.preview.confirmation?.token}).then(applied=>{new Notice(tr("Restore result: ", '恢复结果：')+ configurationStatusLabel(applied.status));review.close();}).catch(()=>{new Notice(tr("Restore failed. Review the current configuration and preview again.", '恢复失败，请重新检查当前状态与预览。'));b.setDisabled(false);});}));
                review.open();return;
            }
            new Notice(tr("Restore result: ", '恢复结果：') + configurationStatusLabel(result.status));
        }
        catch (e) {
            new Notice(configurationErrorText(e));
        }
        finally {
            button.setDisabled(false);
        } })(); }));
    } }); }));
}
