export type ReadingMenuContext = 'editor' | 'preview' | 'pdf' | 'epub' | 'file';
export interface ReadingMenuPreferences {
    enabled?: boolean;
    presentation?: 'flat' | 'submenu';
    contexts?: Partial<Record<ReadingMenuContext, boolean>>;
    actions?: Record<string, {
        enabled?: boolean;
        order?: number;
        label?: string;
    }>;
}
export const READING_ACTION_IDS = ['search', 'current', 'knowledge', 'explain', 'example', 'compare', 'quiz'] as const;
export function resolveReadingMenu<T extends {
    id: string;
    title: string;
}>(context: ReadingMenuContext, items: T[], preferences?: ReadingMenuPreferences): T[] {
    if (preferences?.enabled === false || preferences?.contexts?.[context] === false)
        return [];
    return items.filter(item => preferences?.actions?.[item.id]?.enabled !== false).map((item, index) => ({ ...item, title: preferences?.actions?.[item.id]?.label?.trim() || item.title, menuOrder: preferences?.actions?.[item.id]?.order ?? index })).sort((a, b) => a.menuOrder - b.menuOrder);
}
