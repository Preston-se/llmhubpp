import { Notice, Setting, TFile } from "obsidian";
import { createStorageLayout, resolveStoragePaths, applyStoragePaths, STORAGE_FOLDERS, type StorageLayout } from "src/core/storagePaths";
import { configureRagStorageDirectory } from "src/core/localRagStorage";
import type { SettingsContext } from "./settingsContext";
import { settingsText as tr } from "./settingsText";

export function displayStorageSettings(containerEl: HTMLElement, { plugin }: SettingsContext): void {
  const configDir = plugin.app.vault.configDir;
  const layout = () => createStorageLayout(plugin.settings, configDir);
  const change = async (next: StorageLayout) => {
    try {
      if (plugin.tasks.hasUnfinished()) throw new Error("busy");
      const paths = resolveStoragePaths({ storageLayout: next }, configDir);
      for (const path of [paths.workspace, ...STORAGE_FOLDERS.map(key => paths[key])]) if (path && plugin.app.vault.getAbstractFileByPath(path) instanceof TFile) throw new Error("file");
      const previous = { storageLayout: plugin.settings.storageLayout, workspaceFolder: plugin.settings.workspaceFolder, skillsFolder: plugin.settings.skillsFolder, manualChatSaveFolder: plugin.settings.manualChatSaveFolder };
      plugin.settings.storageLayout = next;
      try { await plugin.saveSettings(); } catch (error) {
        Object.assign(plugin.settings, previous);
        const restored = applyStoragePaths(plugin.settings, configDir);
        configureRagStorageDirectory(restored.workspace, restored.rag);
        throw error;
      }
    } catch {
      new Notice(tr("Could not change the storage path. Use a valid vault folder and finish or cancel active tasks first.", "无法更改存储位置。请使用有效的库内目录，并先完成或取消正在进行的任务。"));
    }
  };
  new Setting(containerEl).setName(tr("Storage root and folders", "存储根目录与各类目录")).setHeading();
  new Setting(containerEl).setName(tr("Plugin data root", "插件数据根目录"))
    .setDesc(tr("Select where new inherited data is stored. Existing files are kept in place; independent and legacy paths do not move.", "设置跟随根目录的新数据位置。已有文件保留原位置，单独设置和旧版路径不会随根目录移动。"))
    .addText(text => { text.setValue(layout().root); text.inputEl.addEventListener("blur", () => {
      if (text.inputEl.value !== layout().root) void change({ ...layout(), root: text.inputEl.value });
    }); });
  const labels = { tools: ["Tools and editable presets", "工具与可编辑预设"], skills: ["Agent skills", "智能体技能"], rag: ["Knowledge base indexes", "知识库索引"],
    chats: ["Automatic chat histories", "自动聊天记录"], exports: ["Manual note exports", "手动导出笔记"], state: ["Workspace configuration", "工作区配置"], tasks: ["Task recovery records", "任务恢复记录"], sources: ["Source conversion manifests", "原资料转换清单"] };
  for (const key of STORAGE_FOLDERS) {
    const current = layout(); const custom = current.overrides[key] !== undefined;
    const path = resolveStoragePaths({ storageLayout: current }, configDir)[key];
    const row = new Setting(containerEl).setName(tr(labels[key][0], labels[key][1]))
      .setDesc(`${custom ? tr("Independent path", "单独设置") : tr("Inherits root", "跟随根目录")} · ${path || tr("Vault root", "库根目录")}${key === "tasks" || key === "sources" ? tr(" · Applies after reloading the plugin", " · 更改后需重新加载插件生效") : ""}`);
    row.addToggle(toggle => toggle.setValue(custom).setTooltip(tr("Set independently", "单独设置此目录")).onChange(async enabled => {
      const next = layout(); if (enabled) next.overrides[key] = path; else delete next.overrides[key];
      await change(next);
    }));
    if (custom) row.addText(text => {
      text.setValue(path); text.inputEl.addEventListener("blur", () => {
        if (text.inputEl.value === layout().overrides[key]) return;
        const next = layout(); next.overrides[key] = text.inputEl.value; void change(next);
      });
    });
  }
  containerEl.createDiv({ text: tr("Obsidian manages plugin installation files and the device secret store. Storage paths and model file-access permissions are configured separately.", "插件安装文件与设备秘密存储由 Obsidian 管理。数据存放位置与模型可访问目录分别设置。") });
}
