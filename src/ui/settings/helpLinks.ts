import { settingsText as tr } from './settingsText';

export interface HelpLink {
    id: string;
    label: string;
    target: string;
    hidden?: boolean;
}

export function defaultHelpLinks(): HelpLink[] {
    return [
        { id: 'wiki', label: 'Wiki', target: 'help:index' },
        { id: 'mcp', label: tr('MCP guide', 'MCP 操作指南'), target: 'help:mcp-agent-guide' },
        { id: 'notice', label: tr('User notes', '用户须知'), target: 'help:user-notice' },
    ];
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
import { HELP_TOPICS } from '../helpRoutes';
import { HELP_ANCHORS } from '../helpAnchors';
