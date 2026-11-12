import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildSearchCatalog, renderSearchCatalog } from "./generate-settings-search.mjs";
test("the checked-in search catalogue covers current renderers, helpers and modals", () => {
  assert.equal(fs.readFileSync(new URL("../src/ui/settings/settingsSearchCatalog.ts", import.meta.url), "utf8"), renderSearchCatalog());
  const catalog = buildSearchCatalog();
  assert.ok(catalog.chat.keys.includes("settings.voiceSubmitPhrase"));
  assert.ok(catalog.safeGuard.aliases.includes("代理层强制 Read Only"));
  assert.ok(catalog.local.keys.includes("settings.localLlmModal.baseUrl"));
  assert.equal(Object.keys(catalog).length, 28);
  assert.ok(catalog.menus.aliases.includes("显示阅读右键菜单"));
  assert.ok(catalog.hotkeys.aliases.includes("配置快捷键"));
  assert.ok(catalog.assistant.aliases.includes("开启 / 查看连接"));
  assert.ok(catalog.transfer.aliases.includes("导出配置包"));
});
