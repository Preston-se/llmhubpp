import { afterEach, expect, it } from "vitest";
import { setLocale, t } from "./index";
import { t as translate } from "obsidian-llm-hub-common/i18n";
import { SETTINGS_SEARCH_CATALOG } from "src/ui/settings/settingsSearchCatalog";

afterEach(() => setLocale("en"));
it("shows Chinese instead of English fallback for the settings reported by the user", () => {
  setLocale("zh-CN");
  expect(t("settings.manualChatSaveFolder")).toBe("手动保存聊天的目录");
  expect(t("settings.skillsFolder")).toBe("技能目录");
  expect(t("settings.jevRagFilter")).toBe("仅保留与问题匹配的检索结果");
  setLocale("en");
  expect(t("settings.manualChatSaveFolder")).toBe("Manual chat save folder");
});

it("translates prose from the shared settings catalogue and preserves the header example", () => {
  const keys = [...new Set(Object.values(SETTINGS_SEARCH_CATALOG).flatMap(section => section.keys))];
  setLocale("en-US");
  const english = new Map(keys.map(key => [key, translate(key)]));
  setLocale("zh-CN");
  const protocolExamples = new Set(["settings.mcpServerHeaders.placeholder"]);
  const fallback = keys.filter(key => {
    const rendered = translate(key);
    return rendered === key || (!protocolExamples.has(key) && rendered === english.get(key) && /[a-z]{3,}\s+[a-z]{3,}/i.test(rendered));
  });
  expect(fallback).toEqual([]);
  expect(translate("settings.mcpServerHeaders.placeholder")).toBe(english.get("settings.mcpServerHeaders.placeholder"));
});
