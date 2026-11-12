import { Modal, Notice, Setting } from 'obsidian';
import type { SettingsContext } from './settingsContext';
import { settingsGroups, type SettingSection } from './settingsRegistry';
import { DEFAULT_HELP_LINKS, resolveHelpLink } from './helpLinks';
import { HelpModal } from '../HelpModal';
import { ConfigurationTransferModal } from './ConfigurationTransferModal';
import { displayAgentConfigurationSettings } from './agentConfigurationSettings';
export function openConfigurationAssistant(ctx: SettingsContext): void { const modal = ctx.plugin.configuration?.trackModal(new Modal(ctx.plugin.app)) ?? new Modal(ctx.plugin.app); modal.setTitle('Agent 辅助配置'); modal.onOpen = () => displayAgentConfigurationSettings(modal.contentEl, ctx); modal.open(); }
function manageLinks(ctx: SettingsContext, refresh: () => void): void {
    ctx={...ctx,plugin:ctx.plugin.configuration?.createUiFacade(ctx.plugin)??ctx.plugin};
    const modal = ctx.plugin.configuration?.trackModal(new Modal(ctx.plugin.app)) ?? new Modal(ctx.plugin.app);
    modal.setTitle('管理首页链接');
    const links = structuredClone(ctx.plugin.settings.settingsAppearance?.helpLinks ?? DEFAULT_HELP_LINKS);
    const render = () => {
        modal.contentEl.empty();
        for (const [index, link] of links.entries())
            new Setting(modal.contentEl).setName(link.label || '新链接').addText(t => t.setPlaceholder('显示名称').setValue(link.label).onChange(v => { link.label = v; })).addText(t => t.setPlaceholder('help:index 或 https://…').setValue(link.target).onChange(v => { link.target = v; })).addToggle(t => t.setValue(!link.hidden).onChange(v => { link.hidden = !v; })).addExtraButton(b => b.setIcon('arrow-up').setTooltip('上移').onClick(() => { if (index > 0) {
                [links[index - 1], links[index]] = [links[index], links[index - 1]];
                render();
            } })).addExtraButton(b => b.setIcon('trash').setTooltip('移除链接').onClick(() => { links.splice(index, 1); render(); }));
        new Setting(modal.contentEl).setName('链接操作').addButton(b => b.setButtonText('添加').onClick(() => { links.push({ id: crypto.randomUUID(), label: '新链接', target: 'https://' }); render(); })).addButton(b => b.setButtonText('恢复内置链接').onClick(() => { links.splice(0, links.length, ...structuredClone(DEFAULT_HELP_LINKS)); render(); })).addButton(b => b.setButtonText('保存').setCta().onClick(() => { void (async () => { try {
            for (const link of links) {
                resolveHelpLink(link.target);
                if (!link.label.trim())
                    throw Error('请填写链接名称');
            }
            ctx.plugin.settings.settingsAppearance = { ...ctx.plugin.settings.settingsAppearance, helpLinks: links };
            await ctx.plugin.saveSettings();
            modal.close();
            refresh();
        }
        catch (e) {
            new Notice(e instanceof Error ? e.message : '链接保存失败');
        } })(); }));
    };
    render();
    modal.open();
}
export function renderSettingsHome(root: HTMLElement, ctx: SettingsContext, renderSection: (section: SettingSection, root: HTMLElement) => (() => void)): () => void {
    root.empty();
    root.addClass('llmhubpp-settings-home');
    const head = root.createDiv({ cls: 'llmhubpp-home-title' });
    head.createEl('strong', { text: 'Llmhub++' });
    head.createSpan({ text: '设置与学习助手' });
    const links = root.createDiv({ cls: 'llmhubpp-home-links' }), hero = root.createDiv({ cls: 'llmhubpp-home-hero' });
    const draw = () => {
        links.empty();
        for (const link of ctx.plugin.settings.settingsAppearance?.helpLinks ?? DEFAULT_HELP_LINKS) {
            if (link.hidden)
                continue;
            const button = links.createEl('button', { text: link.label + ' ↗', cls: 'clickable-icon' });
            button.addEventListener('click', () => { try {
                const resolved = resolveHelpLink(link.target);
                if (resolved.kind === 'help')
                    new HelpModal(ctx.plugin, resolved.target).open();
                else
                    window.open(resolved.target, '_blank', 'noopener');
            }
            catch {
                new Notice('链接无效，请在管理链接中修改。');
            } });
        }
        links.createEl('button', { text: '管理链接', cls: 'clickable-icon' }).addEventListener('click', () => manageLinks(ctx, draw));
        hero.empty();
        const collapsed = ctx.plugin.settings.settingsAppearance?.heroCollapsed === true;
        hero.toggleClass('is-collapsed', collapsed);
        if (!collapsed) {
            hero.createSpan({ text: 'READ · ASK · UNDERSTAND', cls: 'llmhubpp-home-kicker' });
            hero.createEl('h2', { text: '让知识库，成为你的学习伙伴' });
            hero.createEl('p', { text: '从一段文字出发，找到相关资料，带着出处理解知识。读书、检索、提问，在自己的知识库里连起来。' });
            hero.createEl('img', { attr: { src: ctx.plugin.app.vault.adapter.getResourcePath(`${ctx.plugin.manifest.dir}/resources/settings/knowledge-banner.svg`), alt: '展开的书籍与知识关联节点' } });
        }
        hero.createEl('button', { text: collapsed ? '显示介绍' : '收起', cls: 'clickable-icon' }).addEventListener('click', () => { ctx.plugin.settings.settingsAppearance = { ...ctx.plugin.settings.settingsAppearance, heroCollapsed: !collapsed }; void ctx.plugin.saveSettings().then(draw).catch(() => new Notice('保存失败')); });
    };
    draw();
    const cards = root.createDiv({ cls: 'llmhubpp-home-cards' });
    const agent = cards.createEl('button', { cls: 'llmhubpp-home-card' });
    agent.createEl('strong', { text: 'Agent 辅助配置' });
    agent.createSpan({ text: ctx.plugin.configuration?.mcp.getStatus().state === 'open' ? '已开启 · 管理连接' : '让外部 Agent 帮你理解和调整配置' });
    agent.createEl('small', { text: '打开配置助手 ↗' });
    agent.addEventListener('click', () => openConfigurationAssistant(ctx));
    const transfer = cards.createEl('button', { cls: 'llmhubpp-home-card' });
    transfer.createEl('strong', { text: '配置导入 / 导出' });
    transfer.createSpan({ text: '保存自己的配置，在升级后快速恢复' });
    transfer.createEl('small', { text: '管理配置包 ↗' });
    transfer.addEventListener('click', () => new ConfigurationTransferModal(ctx.plugin).open());
    const search = root.createEl('input', { type: 'text', cls: 'llmhubpp-home-search', attr: { placeholder: '搜索设置，例如：右键菜单、嵌入模型、允许目录', 'aria-label': '搜索设置' } }), results = root.createDiv();
    search.addEventListener('input', () => { results.empty(); const q = search.value.trim().toLowerCase(); if (!q)
        return; for (const group of settingsGroups())
        for (const section of group.sections) {
            if (![group.name, section.name, ...section.aliases].some(s => s.toLowerCase().includes(q)))
                continue;
            new Setting(results).setName(group.name + ' / ' + section.name).addButton(b => b.setButtonText('打开').onClick(() => {
                const modal = new Modal(ctx.plugin.app); let unmount: (() => void) | undefined;
                modal.setTitle(section.name);
                modal.onOpen = () => { unmount = renderSection(section, modal.contentEl); };
                modal.onClose = () => { unmount?.(); modal.contentEl.empty(); };
                (ctx.plugin.configuration?.trackModal(modal) ?? modal).open();
            }));
        } });
    root.createDiv({ text: 'takeshy（原作者）、Peter、Codex', cls: 'llmhubpp-home-author' });
    return () => { };
}
