import { expect, it } from "vitest";
import { setLocale, t } from "./index";
it("shows Chinese instead of English fallback for the settings reported by the user", () => {
  setLocale("zh-CN");
  expect(t("settings.manualChatSaveFolder")).toBe("手动保存聊天的目录");
  expect(t("settings.skillsFolder")).toBe("技能目录");
  expect(t("settings.jevRagFilter")).toBe("仅保留与问题匹配的检索结果");
  setLocale("en");
  expect(t("settings.manualChatSaveFolder")).toBe("Manual chat save folder");
});
