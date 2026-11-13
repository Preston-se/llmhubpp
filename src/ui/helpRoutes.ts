import { settingsText as tr } from './settings/settingsText';

export const HELP_TOPICS: Record<string, string> = { index: '功能地图', 'first-setup': '首次配置', sources: '资料解析', retrieval: '知识库检索', reading: '阅读右键', 'grounded-answers': '资料问答', customization: '菜单与快捷键', storage: '目录与继承', permissions: '权限与 Safe Guard', workflows: '工作流与扩展', 'mcp-agent-guide': 'Agent 配置指南', 'configuration-backup': '配置导出与恢复', 'configuration-fields': '全部配置字段', troubleshooting: '故障排查', 'user-notice': '用户须知' };
HELP_TOPICS.requests='用量、预算与隐私';
HELP_TOPICS['agent-onboarding']='协作配置的五个问题';

const englishTitles: Record<string, string> = {
    index: 'Feature map', 'first-setup': 'First setup', sources: 'Source conversion',
    retrieval: 'Knowledge-base retrieval', reading: 'Reading actions', 'grounded-answers': 'Answers with citations',
    customization: 'Menus and hotkeys', storage: 'Folders and inheritance', permissions: 'Permissions and Safe Guard',
    workflows: 'Workflows and extensions', 'mcp-agent-guide': 'Agent configuration',
    'configuration-backup': 'Configuration backup and restore', 'configuration-fields': 'Configuration fields',
    troubleshooting: 'Troubleshooting', 'user-notice': 'User notes', requests: 'Usage, budget, and privacy',
    'agent-onboarding': 'Five questions for assisted setup',
};

export function helpTopicTitle(id: string): string {
    return tr(englishTitles[id] ?? id, HELP_TOPICS[id] ?? id);
}
