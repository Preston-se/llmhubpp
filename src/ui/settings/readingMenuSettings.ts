import { Notice, Setting } from 'obsidian';
import type { SettingsContext } from './settingsContext';
import { READING_ACTION_IDS, type ReadingMenuPreferences, type ReadingMenuContext } from '../readingMenuPolicy';
import { t } from '../../i18n';
export function displayReadingMenuSettings(root: HTMLElement, ctx: SettingsContext): void {
    const { plugin } = ctx;
    let draft: ReadingMenuPreferences = structuredClone(plugin.settings.readingMenus ?? {});
    const save = async () => { plugin.settings.readingMenus = structuredClone(draft); try {
        await plugin.saveSettings();
    }
    catch (e) {
        new Notice(e instanceof Error ? e.message : '菜单设置保存失败');
    } };
    new Setting(root).setName('显示阅读右键菜单').addToggle(t => t.setValue(draft.enabled !== false).onChange(v => { draft.enabled = v; void save(); }));
    new Setting(root).setName('菜单呈现').addDropdown(d => d.addOption('flat', '直接显示动作').addOption('submenu', '归入 Llmhub++ 子菜单').setValue(draft.presentation ?? 'flat').onChange(v => { draft.presentation = v as 'flat' | 'submenu'; void save(); }));
    for (const [scene, label] of Object.entries({ editor: 'Markdown 编辑器', preview: 'Markdown 阅读预览', pdf: 'PDF 阅读器', epub: '可访问 EPUB 阅读器', file: '文件菜单' }))
        new Setting(root).setName(label).addToggle(t => t.setValue(draft.contexts?.[scene as ReadingMenuContext] !== false).onChange(v => { draft.contexts = { ...draft.contexts, [scene]: v }; void save(); }));
    const labels = { search: t('reading.search'), current: t('reading.askCurrent'), knowledge: t('reading.askKnowledge'), explain: t('reading.explain'), example: t('reading.example'), compare: t('reading.compare'), quiz: t('reading.quiz') };
    for (const [index, id] of READING_ACTION_IDS.entries()) {
        const action = () => draft.actions?.[id] ?? {};
        const update = (value: {
            enabled?: boolean;
            label?: string;
            order?: number;
        }) => { draft.actions = { ...draft.actions, [id]: { ...action(), ...value } }; void save(); };
        new Setting(root).setName(labels[id]).setDesc('显示名称可留空使用默认值；顺序越小越靠前。可用动作仍取决于阅读场景。').addToggle(t => t.setValue(action().enabled !== false).onChange(v => update({ enabled: v }))).addText(t => t.setPlaceholder(labels[id]).setValue(action().label ?? '').onChange(v => update({ label: v.slice(0, 80) }))).addText(t => t.setValue(String(action().order ?? index)).onChange(v => { const n = Number(v); if (Number.isFinite(n))
            update({ order: n }); }));
    }
    new Setting(root).setName('恢复菜单默认值').setDesc('仅恢复菜单显示偏好。').addButton(b => b.setButtonText('恢复默认').onClick(() => { draft = {}; void save().then(ctx.display); }));
}
