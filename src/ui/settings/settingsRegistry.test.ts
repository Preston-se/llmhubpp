import { expect, it } from "vitest";
import { settingsGroups, buildSettingsPages } from "./settingsRegistry";
import { setLocale } from "src/i18n";
import { execFileSync } from "node:child_process";
import { SETTINGS_SEARCH_CATALOG } from "./settingsSearchCatalog";
it("exposes all seven navigable groups and search aliases for the actual settings", () => {
  setLocale("zh");
  expect(settingsGroups().map(group => group.name)).toEqual(["模型与连接", "资料与知识库", "阅读与对话", "工具与权限", "工作区与存储", "工作流与扩展", "安全与高级"]);
  const ids = settingsGroups().flatMap(group => group.sections.map(section => section.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(Object.keys(SETTINGS_SEARCH_CATALOG).sort());
  expect(ids).toEqual(expect.arrayContaining(["api", "local", "cli", "proxy", "source", "rag", "jev", "okf", "chat", "history", "workspace", "storage", "credentials", "workflow", "slash", "externalSkills", "mcp", "agent", "safeGuard", "edits", "encryption", "langfuse"]));
  const pages = buildSettingsPages(() => () => undefined) as any[];
  expect(pages.every(page => page.type === "page" && page.items.every((child: any) => child.type === "page"))).toBe(true);
  const aliases = pages.flatMap(page => page.items.flatMap((child: any) => child.items.flatMap((entry: any) => entry.aliases)));
  expect(aliases).toContain("最大工具调用次数"); expect(aliases).toContain("相似度阈值"); expect(aliases).toContain("Skills folder");
  setLocale("en");
});

it("keeps search coverage in sync with all actual controls and their shared helpers", () => {
  execFileSync(process.execPath, ["scripts/generate-settings-search.mjs", "--check"], { stdio: "pipe" });
});

it("finds real shared, host, modal and Safe Guard control names on their owning pages", () => {
  setLocale("zh");
  const groups = settingsGroups();
  const aliases = (id: string) => groups.flatMap(group => group.sections).find(section => section.id === id)!.aliases;
  for (const [id, labels] of Object.entries({
    chat: ["Send phrase", "发送短语"],
    safeGuard: ["代理层强制 Read Only", "默认压缩模型"],
    storage: ["Automatic chat histories", "自动聊天记录", "原资料转换清单"],
    source: ["Directory regular expressions", "目录正则表达式"],
  })) for (const label of labels) expect(aliases(id)).toContain(label);
  expect(aliases("chat")).not.toContain("代理层强制 Read Only");
  setLocale("en");
});
