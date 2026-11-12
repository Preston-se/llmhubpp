import type { SettingDefinitionItem } from "obsidian";
import { settingsText as tr } from "./settingsText";
import { t as translate } from "obsidian-llm-hub-common/i18n";
import { SETTINGS_SEARCH_CATALOG } from "./settingsSearchCatalog";
export interface SettingSection { id: string; name: string; aliases: string[] }
type SectionTuple = [id: string, english: string, chinese: string, aliases: string[]];
export function settingsGroups(): Array<{ id: string; name: string; sections: SettingSection[] }> {
  const groups: Array<[string, string, string, SectionTuple[]]> = [
    ["models", "Models and connections", "模型与连接", [
      ["api", "Remote API providers", "远程模型服务", ["API provider", "base URL", "API key", "模型验证", "模型列表", "PDF输入模式"]],
      ["local", "Local models", "本地模型", ["Ollama", "LM Studio", "vLLM", "工具降级", "超时", "连接验证"]],
      ["cli", "CLI connections", "命令行模型", ["Claude", "Codex", "OpenCode", "命令行路径", "推理强度"]],
      ["proxy", "Proxy and routing", "代理与路由", ["proxy", "代理地址", "绕过代理", "路由"]],
    ]],
    ["knowledge", "Sources and knowledge bases", "资料与知识库", [
      ["source", "Source conversion", "原资料处理", ["正则", "监听", "包含目录", "排除目录", "附件目录", "转换", "任务", "专用索引"]],
      ["rag", "Indexes and retrieval", "索引与检索", ["RAG", "Top K", "相似度阈值", "分块大小", "重叠", "嵌入模型", "同步", "合并索引", "外部索引", "编辑后等待", "继续等待", "Index wait"]],
      ["jev", "Result filtering", "检索结果筛选", ["Jev", "OpenRouter", "匹配结果"]],
      ["okf", "Knowledge sources", "知识来源", ["OKF", "知识目录", "知识包"]],
    ]],
    ["reading", "Reading and chat", "阅读与对话", [
      ['menus','Reading context menus','阅读右键菜单',['右键','显示名称','排序','子菜单']],
      ['hotkeys','Keyboard shortcuts','快捷键',['快捷键冲突','默认不绑定']],
      ["chat", "Chat and voice", "对话与语音", ["语音发送", "voice", "chat", "默认基于知识库回答", "Grounded answers"]],
      ["history", "History and prompts", "历史与提示词", ["聊天记录", "最大保存数", "系统提示词", "隐藏工作区", "history", "system prompt"]],
    ]],
    ["permissions", "Tools and permissions", "工具与权限", [
      ['requests','Usage, budget and outgoing privacy','用量、预算与发送隐私',['费用','预算','脱敏','联网查询','原文','Token','用量']],
      ["workspace", "Vault access and limits", "仓库访问与工具限制", ["All", "只读", "允许目录", "模型工具可访问的目录", "最大工具调用次数", "警告阈值", "笔记长度", "列表限制"]],
    ]],
    ["storage", "Workspace and storage", "工作区与存储", [
      ["storage", "Folders and inheritance", "目录与继承", ["工作区文件夹", "Skills folder", "手动聊天保存目录", "tools", "skills", "rag", "根目录", "任务恢复", "存储"]],
      ["credentials", "Credentials", "凭据存储", ["API密钥", "令牌", "SecretStorage", "明文", "设备"]],
    ]],
    ["extensions", "Workflows and extensions", "工作流与扩展", [
      ["workflow", "Workflows and editable presets", "工作流与可编辑预设", ["Inbox", "预设", "脚本", "事件触发", "workflow"]],
      ["slash", "Slash commands", "斜杠命令", ["命令", "快捷指令", "skill", "prompt"]],
      ["externalSkills", "Skills", "技能管理", ["Agent skills", "外部技能", "更新技能", "导入技能"]],
      ["mcp", "MCP servers", "MCP 服务", ["MCP", "允许工具", "自动批准", "审批", "Apps"]],
      ["agent", "Agent plugins", "智能体扩展", ["智能体", "安装扩展", "agent plugins"]],
    ]],
    ["advanced", "Safety and advanced", "安全与高级", [
      ['assistant','Agent configuration','Agent 辅助配置',['MCP 配置服务','Codex','Claude']],
      ['transfer','Configuration import and export','配置导入与导出',['备份','恢复','升级']],
      ['precision','Fine-grained configuration','精细配置',['字段','配置预览']],
      ['help','Wiki and help','Wiki 与帮助',['指南','用户须知']],
      ["safeGuard", "Safe Guard", "安全防护", ["只读代理", "资源守卫", "路由", "上下文压缩", "CPU", "GPU", "安全端口"]],
      ["edits", "Edit history", "编辑历史", ["编辑恢复", "差异", "保留版本"]],
      ["encryption", "Encryption", "加密", ["密码", "自动锁定", "加密笔记"]],
      ["langfuse", "Diagnostics and tracing", "诊断与追踪", ["Langfuse", "日志", "追踪"]],
    ]],
  ];
  return groups.map(([id, en, zh, items]) => ({ id, name: tr(en, zh), sections: items.map(([key, english, chinese, aliases]) => {
    const controls = SETTINGS_SEARCH_CATALOG[key]??{aliases:[],keys:[]};
    return { id: key, name: tr(english, chinese), aliases: [...new Set([english, chinese, ...aliases, ...controls.aliases, ...controls.keys.map(label => translate(label))])] };
  }) }));
}
export function buildSettingsPages(render: (section: SettingSection, root: HTMLElement) => (() => void)): SettingDefinitionItem[] {
  return settingsGroups().map(group => ({ type: "page", name: group.name, items: group.sections.map(item => ({
    type: "page", name: item.name, items: [{ name: item.name, aliases: item.aliases, render: setting => render(item, setting.settingEl) }],
  })) }));
}
