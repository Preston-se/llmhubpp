import { Setting, Notice } from "obsidian";
import { t } from "src/i18n";
import { DEFAULT_SLASH_COMMANDS, type ModelType, type SlashCommand } from "src/types";
import { settingsText as tr } from "./settingsText";
import { SlashCommandModal, type SlashCommandModalOptions } from "obsidian-llm-hub-common/modals";
import type { SettingsContext } from "./settingsContext";
import { discoverSkills } from "src/core/skillsLoader";

export function displaySlashCommandSettings(containerEl: HTMLElement, ctx: SettingsContext): void {
  const { plugin, display } = ctx;
  const app = plugin.app;
  const enabledProviders = plugin.settings.apiProviders.filter(p => p.enabled && p.verified);
  const availableModels = enabledProviders.flatMap(p =>
    p.enabledModels.map(m => ({
      name: `api:${p.id}:${m}` as ModelType,
      displayName: `${p.name} (${m})`,
      description: `${p.type} API provider`,
    }))
  );
  const modalOptions: SlashCommandModalOptions = {
    models: availableModels,
    search: { webSearch: true, ragSettings: plugin.getRagSettingNames(), combinable: true },
    mcpServers: plugin.settings.mcpServers,
    editConfirmation: true,
  };
  const openCommandModal = async (
    command: SlashCommand | null,
    onSubmit: (command: SlashCommand) => void | Promise<void>,
  ): Promise<void> => {
    const skills = await discoverSkills(app, plugin.settings.skillsFolder);
    new SlashCommandModal(app, command, { ...modalOptions, skills }, onSubmit).open();
  };

  new Setting(containerEl).setName(t("settings.slashCommands")).setHeading();

  new Setting(containerEl)
    .setName(t("settings.manageCommands"))
    .setDesc(t("settings.manageCommands.desc"))
    .addButton((btn) =>
      btn
        .setButtonText(t("settings.addCommand"))
        .setCta()
        .onClick(() => {
          void openCommandModal(
            null,
            async (command: SlashCommand) => {
              plugin.settings.slashCommands.push(command);
              await plugin.saveSettings();
              display();
              new Notice(t("settings.commandCreated", { name: command.name }));
            }
          );
        })
    );

  // List existing commands
  if (plugin.settings.slashCommands.length > 0) {
    for (const command of plugin.settings.slashCommands) {
      const builtIn = DEFAULT_SLASH_COMMANDS[0];
      const description = command.id === builtIn.id && command.description && command.description === builtIn.description
        ? tr(command.description, "根据选区或当前笔记生成 HTML 信息图")
        : command.description;
      const commandSetting = new Setting(containerEl)
        .setName(`/${command.name}`)
        .setDesc(
          description ||
            command.promptTemplate.slice(0, 50) +
              (command.promptTemplate.length > 50 ? "..." : "")
        );

      // Edit button
      commandSetting.addExtraButton((btn) => {
        btn
          .setIcon("pencil")
          .setTooltip(t("settings.editCommand"))
          .onClick(() => {
            void openCommandModal(
              command,
              async (updated: SlashCommand) => {
                const index = plugin.settings.slashCommands.findIndex(
                  (c) => c.id === command.id
                );
                if (index >= 0) {
                  plugin.settings.slashCommands[index] = updated;
                  await plugin.saveSettings();
                  display();
                  new Notice(t("settings.commandUpdated", { name: updated.name }));
                }
              }
            );
          });
      });

      // Delete button
      commandSetting.addExtraButton((btn) => {
        btn
          .setIcon("trash")
          .setTooltip(t("settings.deleteCommand"))
          .onClick(() => {
            void (async () => {
              plugin.settings.slashCommands =
                plugin.settings.slashCommands.filter(
                  (c) => c.id !== command.id
                );
              await plugin.saveSettings();
              display();
              new Notice(t("settings.commandDeleted", { name: command.name }));
            })();
          });
      });
    }
  }
}
