import { Notice, Setting } from "obsidian";
import { DEFAULT_SOURCE_WATCH, matchSourceDirectory, validateSourcePatterns, type SourceWatchPolicy } from "src/core/sourceWatchPolicy";
import { SourceDocumentError } from "src/core/sourceDocuments";
import { sourceErrorText } from "src/ui/sourceReading";
import { t } from "src/i18n";
import type { SettingsContext } from "./settingsContext";
import { getStoragePaths, isManagedRootExport, managedStorageDirectories } from "src/core/storagePaths";

export function displaySourceIngestSettings(containerEl: HTMLElement, { plugin }: SettingsContext): void {
  const current = (): SourceWatchPolicy => plugin.settings.sourceWatch ?? { ...DEFAULT_SOURCE_WATCH };
  const save = async (patch: Partial<SourceWatchPolicy>) => {
    const next = { ...current(), ...patch };
    try { validateSourcePatterns(next); } catch { next.enabled = false; }
    plugin.settings.sourceWatch = next; await plugin.saveSettings();
  };
  new Setting(containerEl).setName(t("settings.sourceIngest")).setHeading();
  new Setting(containerEl).setName(t("settings.sourceWatchEnabled")).setDesc(t("settings.sourceWatchEnabled.desc"))
    .addToggle(toggle => toggle.setValue(current().enabled).onChange(async enabled => {
      try { validateSourcePatterns(current()); } catch { new Notice(t("reading.patternInvalid")); toggle.setValue(false); return; }
      await save({ enabled });
    }));
  new Setting(containerEl).setName(t("settings.sourceWatchMode")).addDropdown(dropdown => dropdown
    .addOption("include", t("settings.sourceWatchInclude")).addOption("exclude", t("settings.sourceWatchExclude"))
    .setValue(current().mode).onChange(mode => save({ mode: mode === "exclude" ? "exclude" : "include" })));
  new Setting(containerEl).setName(t("settings.sourceWatchPatterns")).setDesc(t("settings.sourceWatchPatterns.desc"))
    .addTextArea(text => text.setValue(current().folderPatterns.join("\n")).onChange(value => save({ folderPatterns: value.split(/\r?\n/).filter(Boolean) })));
  const preview = containerEl.createDiv();
  void (async () => { try {
    const paths = getStoragePaths(plugin.settings, plugin.app.vault.configDir);
    const candidates = plugin.app.vault.getFiles().filter(file => matchSourceDirectory(file.path, current(), paths.workspace, plugin.app.vault.configDir, managedStorageDirectories(paths)));
    const examples: string[] = [];
    for (const file of candidates) {
      if (!await isManagedRootExport(plugin.app.vault.adapter, paths, file.path)) examples.push(file.path);
      if (examples.length === 8) break;
    }
    preview.setText(t("settings.sourceWatchPreview") + "\n" + examples.join("\n"));
    preview.addClass("llm-hub-source-preview");
  } catch { preview.setText(t("reading.patternInvalid")); } })();
  new Setting(containerEl).setName(t("settings.sourceWatchIndex")).setDesc(t("settings.sourceWatchIndex.desc"))
    .addText(text => text.setValue(current().indexName).setDisabled(Object.values(plugin.workspaceState.ragSettings).some(setting => setting.sourceCollection))
      .onChange(indexName => save({ indexName })));
  new Setting(containerEl).setName(t("settings.sourceWatchAttachment")).setDesc(t("settings.sourceWatchAttachment.desc"))
    .addText(text => text.setValue(current().attachmentFolder).onChange(async attachmentFolder => {
      if (attachmentFolder && (/^(?:[\\/]|[a-z]:)/i.test(attachmentFolder) || attachmentFolder.split(/[\\/]/).some(part => part === ".." || part === "."))) {
        new Notice(sourceErrorText(new SourceDocumentError("corrupt"))); return;
      }
      await save({ attachmentFolder });
    }));
  new Setting(containerEl).setName(t("settings.sourceWatchScan")).setDesc(t("settings.sourceWatchScan.desc"))
    .addButton(button => button.setButtonText(t("settings.sourceWatchScan")).onClick(() => {
      void plugin.sourceIngest?.scan().catch(error => new Notice(sourceErrorText(error)));
    })).addButton(button => button.setButtonText(t("settings.sourceWatchTasks")).onClick(() => plugin.openTaskMonitor()));
}
