import type { Plugin } from "obsidian";
import { getLocale } from "src/i18n";
const labels: Record<string, string> = {
  "Startup": "启动完成", "Triggered once when the Obsidian workspace is ready": "Obsidian 工作区就绪时触发一次",
  "File Created": "创建文件", "Triggered when a new file is created": "新文件创建时触发",
  "File Modified": "修改文件", "Triggered when a file is saved": "文件保存时触发",
  "File Deleted": "删除文件", "Triggered when a file is deleted": "文件删除时触发",
  "File Renamed": "重命名文件", "Triggered when a file is renamed": "文件重命名时触发",
  "File Opened": "打开文件", "Triggered when a file is opened": "文件打开时触发",
  "File pattern (optional)": "文件匹配规则（可选）", "Save": "保存", "Remove all triggers": "移除全部触发器", "Cancel": "取消",
  "Select which Obsidian events should trigger this workflow.": "选择触发此工作流的 Obsidian 事件。",
  "Filter files by pattern. Use '**/*.md' for all .md files, 'journal/*.md' for a specific folder, '*.md' for root only. Supports {a,b} and [abc] patterns. Leave empty to match all files. Ignored for startup triggers.": "按文件路径模式筛选。**/*.md 匹配所有 Markdown，journal/*.md 匹配指定目录，*.md 仅匹配库根目录。支持 {a,b} 和 [abc]，留空匹配全部文件；启动事件不使用此规则。",
};
export function localizeWorkflowModal(root: HTMLElement): void {
  if (getLocale() !== "zh") return;
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("h2, p, .setting-item-name, .setting-item-description, button"))) {
    const value = node.textContent ?? "";
    const translated = labels[value] ?? (value.startsWith("Event Triggers: ") ? "事件触发：" + value.slice(16) : undefined);
    if (translated) node.textContent = translated;
  }
}
export function installWorkflowModalLocalization(plugin: Plugin): void {
  if (typeof MutationObserver === "undefined") return;
  const observer = new MutationObserver(() => {
    if (getLocale() !== "zh") return;
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(".llm-hub-workflow-event-trigger-modal"))) localizeWorkflowModal(root);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  plugin.register(() => observer.disconnect());
}
