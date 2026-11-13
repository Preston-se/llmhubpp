import { HELP_TOPICS } from '../helpRoutes';
import { HELP_ANCHORS } from '../helpAnchors';
import { settingsText as tr } from './settingsText';

export interface HelpLink {
    id: string;
    label: string;
    target: string;
    hidden?: boolean;
}

const builtInLinks = [
    { id: 'wiki', target: 'help:index', en: 'Wiki', zh: 'Wiki' },
    { id: 'mcp', target: 'help:mcp-agent-guide', en: 'MCP guide', zh: 'MCP 操作指南' },
    { id: 'notice', target: 'help:user-notice', en: 'User notes', zh: '用户须知' },
];

export function defaultHelpLinks(): HelpLink[] {
    return builtInLinks.map(({ id, target, en, zh }) => ({ id, target, label: tr(en, zh) }));
}

export function helpLinkLabel(link: HelpLink): string {
    const builtIn = builtInLinks.find(({ id, target, en, zh }) =>
        id === link.id && target === link.target && (link.label === en || link.label === zh));
    return builtIn ? tr(builtIn.en, builtIn.zh) : link.label;
}

export function resolveHelpLink(target: string): {
    kind: 'help' | 'web';
    target: string;
} {
    if (/^help:[a-z][a-z0-9-]*(?:#[a-z0-9-]+)?$/.test(target)) {
        const [topic, anchor] = target.slice(5).split('#');
        if (!HELP_TOPICS[topic] || anchor && !HELP_ANCHORS[topic]?.includes(anchor))
            throw Error(tr('Help topic not found', '帮助目标不存在'));
        return { kind: 'help', target: target.slice(5) };
    }
    const url = new URL(target);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw Error(tr('Invalid link URL', '链接地址无效'));
    return { kind: 'web', target: url.toString() };
}
