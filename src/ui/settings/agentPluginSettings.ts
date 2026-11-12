import { settingsText as tr } from "./settingsText";
import { Notice, Setting } from "obsidian";
import { clearMcpToolsCache } from "src/core/mcpTools";
import { agentPluginAbsolutePaths, installAgentPlugin, parseAgentPluginMcp, previewAgentPlugin, uninstallAgentPlugin } from "src/core/agentPlugins";
import type { AgentPluginInstall, McpServerConfig } from "src/types";
import type { SettingsContext } from "./settingsContext";
import { AgentPluginInstallModal } from "./AgentPluginInstallModal";
import { ConfirmModal } from "src/ui/components/ConfirmModal";

function mergeServer(next: McpServerConfig, previous?: McpServerConfig): McpServerConfig {
  if (!previous) return next;
  const same = next.transport === previous.transport && next.url === previous.url && next.command === previous.command && JSON.stringify(next.args ?? []) === JSON.stringify(previous.args ?? []) && JSON.stringify(next.env ?? {}) === JSON.stringify(previous.env ?? {});
  return same ? { ...next, enabled: previous.enabled, toolHints: previous.toolHints } : next;
}

export function displayAgentPluginSettings(containerEl: HTMLElement, ctx: SettingsContext): void {
  const { plugin, display } = ctx;
  new Setting(containerEl).setName(tr("Agent plugins", "智能体扩展")).setHeading();
  containerEl.createDiv({ cls: "setting-item-description", text: tr("Install portable Agent Plugins v1.0.0 from a public GitHub repository. Packages are pinned to a commit and stored in .llm-hub/agent-plugins.", "从公开 GitHub 仓库安装 Agent Plugins v1.0.0 扩展。扩展固定到指定提交，存储在 .llm-hub/agent-plugins。") });
  let repository = "";
  new Setting(containerEl).setName(tr("GitHub repository", "GitHub 仓库")).setDesc(tr("owner/repository or a GitHub URL", "填写所有者/仓库名或 GitHub 地址"))
    .addText(text => text.setPlaceholder("owner/repository").onChange(value => { repository = value; }))
    .addButton(button => button.setButtonText(tr("Preview and install", "预览并安装")).setCta().onClick(() => { void (async () => {
      button.setDisabled(true); try {
        const preview = await previewAgentPlugin(repository);
        const prior = new Map(plugin.settings.mcpServers.filter(v => v.agentPlugin?.pluginName === preview.manifest.name).map(v => [v.agentPlugin!.serverName, v]));
        const paths = agentPluginAbsolutePaths(plugin.app, preview.manifest.name);
        let managed: McpServerConfig[] = [];
        const mcp = preview.files["mcp.json"];
        if (mcp) managed = parseAgentPluginMcp<McpServerConfig>(new TextDecoder().decode(mcp), preview.manifest.name, paths.root, paths.data).servers.map(v => mergeServer(v, prior.get(v.agentPlugin!.serverName)));
        let metadata: AgentPluginInstall | null = null;
        new AgentPluginInstallModal(plugin.app, preview, managed, async () => {
          metadata = await installAgentPlugin(plugin.app, preview);
        }, async testedServers => {
          if (!metadata) throw new Error(tr("Agent Plugin installation did not complete.", "智能体扩展安装未完成。"));
          const installed = metadata;
          plugin.settings.agentPlugins = [...(plugin.settings.agentPlugins ?? []).filter(v => v.name !== installed.name), installed];
          plugin.settings.mcpServers = [...plugin.settings.mcpServers.filter(v => v.agentPlugin?.pluginName !== installed.name), ...testedServers];
          await plugin.saveSettings(); clearMcpToolsCache(); plugin.settingsEmitter.emit("skills-changed"); display();
        }).open();
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); } finally { button.setDisabled(false); }
    })(); }));

  for (const item of plugin.settings.agentPlugins ?? []) {
    const skills = item.skillNames.join(", ") || tr("none", "无");
    const setting = new Setting(containerEl).setName(item.name).setDesc(`${item.version} · ${item.repo}@${item.commitSha.slice(0, 7)} · ${tr(`Skills: ${skills}`, `技能：${skills}`)}`);
    setting.addToggle(toggle => toggle.setValue(item.enabled).setTooltip(item.enabled ? tr("Disable", "停用") : tr("Enable", "启用")).onChange(value => { void (async () => {
      item.enabled = value;
      await plugin.app.vault.adapter.write(`.llm-hub/agent-plugins/${item.name}/install.json`, JSON.stringify(item, null, 2));
      for (const server of plugin.settings.mcpServers) if (server.agentPlugin?.pluginName === item.name && !value) server.enabled = false;
      await plugin.saveSettings(); clearMcpToolsCache(); plugin.settingsEmitter.emit("skills-changed"); display();
    })(); }));
    setting.addExtraButton(button => button.setIcon("refresh-cw").setTooltip(tr("Check for update", "检查更新")).onClick(() => { repository = item.repo; void (async () => {
      try { const next = await previewAgentPlugin(item.repo); if (next.commitSha === item.commitSha) new Notice(tr(`${item.name} is up to date.`, `${item.name} 已是最新版本。`)); else new Notice(tr(`Update available for ${item.name}: ${next.version}. Use Preview and install above to review it.`, `发现 ${item.name} 的新版本：${next.version}。请使用上方“预览并安装”查看。`)); } catch (error) { new Notice(String(error)); }
    })(); }));
    setting.addExtraButton(button => button.setIcon("trash").setTooltip(tr("Uninstall", "卸载")).onClick(() => { void (async () => {
      const confirmed = await new ConfirmModal(
        plugin.app,
        tr(`Uninstall ${item.name}?`, `卸载 ${item.name}？`),
        tr("Uninstall", "卸载"),
        tr("Cancel", "取消"),
      ).openAndWait();
      if (!confirmed) return;
      try {
        await uninstallAgentPlugin(plugin.app, item.name);
        plugin.settings.agentPlugins = plugin.settings.agentPlugins.filter((v: AgentPluginInstall) => v.name !== item.name);
        plugin.settings.mcpServers = plugin.settings.mcpServers.filter(v => v.agentPlugin?.pluginName !== item.name);
        await plugin.saveSettings();
        clearMcpToolsCache();
        plugin.settingsEmitter.emit("skills-changed");
        new Notice(tr(`Uninstalled ${item.name}. Plugin data was preserved.`, `已卸载 ${item.name}，扩展数据已保留。`));
        display();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    })(); }));
  }
}
