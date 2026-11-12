import { Modal, PluginSettingTab, Setting, type App, type SettingDefinitionItem } from "obsidian";
import type { LlmHubPlugin } from "src/plugin";
import type { SettingsContext } from "./settings/settingsContext";
import { buildSettingsPages,settingsGroups, type SettingSection } from "./settings/settingsRegistry";
import { captureSettingsViewState, restoreSettingsViewState, type SettingsViewState } from "./settings/settingsViewState";
import { settingsText as tr } from "./settings/settingsText";
import { getStoragePaths } from "src/core/storagePaths";
import { ChatView, VIEW_TYPE_GEMINI_CHAT } from "./ChatView";
import { displayCredentialStorageSettings } from "./settings/credentialStorageSettings";
import { displayCliSettings } from "./settings/cliSettings";
import { displayLocalLlmSettings } from "./settings/localLlmSettings";
import { displayToolPermissionSettings, displayChatBehaviorSettings } from "./settings/workspaceSettings";
import { displayChatSettings } from "./settings/chatSettings";
import { displayKnowledgeSettings } from "./settings/knowledgeSettings";
import { displayEditHistorySettings } from "./settings/editHistorySettings";
import { displayEncryptionSettings } from "./settings/encryptionSettings";
import { displayLangfuseSettings } from "./settings/langfuseSettings";
import { displaySlashCommandSettings } from "./settings/slashCommandSettings";
import { displayExternalSkillSettings } from "./settings/externalSkillSettings";
import { displayRagSettings } from "./settings/ragSettings";
import { displayMcpServersSettings } from "./settings/mcpServersSettings";
import { displayApiProviderSettings } from "./settings/apiProviderSettings";
import { displayJevSettings } from "./settings/jevSettings";
import { displayProxySettings } from "./settings/proxySettings";
import { displayAgentPluginSettings } from "./settings/agentPluginSettings";
import { displayStorageSettings } from "./settings/storageSettings";
import { displaySourceIngestSettings } from "./settings/sourceIngestSettings";
import { displayRequestControls } from './settings/requestControlsSettings';
import {renderSettingsHome} from './settings/settingsHome';
import {displayAgentConfigurationSettings} from './settings/agentConfigurationSettings';
import {ConfigurationTransferModal} from './settings/ConfigurationTransferModal';
import {ConfigurationEditorModal} from './settings/ConfigurationEditorModal';
import {displayReadingMenuSettings} from './settings/readingMenuSettings';
import {displayHotkeySettings} from './settings/hotkeySettings';
import {HelpModal} from './HelpModal';
const buildSection=(id:string)=>settingsGroups().flatMap(g=>g.sections).find(s=>s.id===id);

export class SettingsTab extends PluginSettingTab {
  private syncCancelRef = { value: false, controllers: new Map<string, AbortController>() };
  private mounted = new Map<HTMLElement, { section: SettingSection; kind: "page" | "modal" }>();
  private viewStates = new Map<string, SettingsViewState>();
  private settingsListener: (() => void) | null = null;
  constructor(app: App, public plugin: LlmHubPlugin) { super(app, plugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const pages=buildSettingsPages((section, root) => this.mountSection(section, root, "page"));
    return [{name:'Llmhub++',aliases:['Wiki','MCP','配置导入','配置导出'],render:setting=>renderSettingsHome(setting.settingEl,{plugin:this.plugin,display:()=>this.refreshMounted(),syncCancelRef:this.syncCancelRef},(section,root)=>this.mountSection(section,root,"modal"))},...pages];
  }
  openSection(id:string):void {
    const section=buildSection(id);if(!section)return;
    const modal=new Modal(this.app);let unmount:(()=>void)|undefined;
    modal.setTitle(section.name);
    modal.onOpen=()=>{unmount=this.mountSection(section,modal.contentEl,"modal");};
    modal.onClose=()=>{unmount?.();modal.contentEl.empty();};
    (this.plugin.configuration?.trackModal(modal)??modal).open();
  }
  private mountSection(section: SettingSection, root: HTMLElement, kind: "page" | "modal"): () => void {
    this.mounted.set(root, { section, kind });
    if (!this.settingsListener) {
      this.settingsListener = () => this.refreshMounted();
      this.plugin.settingsEmitter.on("settings-updated", this.settingsListener);
    }
    this.renderSection(section, root);
    return () => this.unmountSection(root);
  }
  private unmountSection(root: HTMLElement): void {
    const entry=this.mounted.get(root);
    if(entry)this.viewStates.set(entry.section.id,captureSettingsViewState(root));
    this.mounted.delete(root);
    if(!this.mounted.size&&this.settingsListener){
      this.plugin.settingsEmitter.off("settings-updated",this.settingsListener);
      this.settingsListener=null;
    }
  }
  private renderSection(section: SettingSection, root: HTMLElement): void {
    root.empty(); root.addClass("llm-hub-settings-render-root");
    const ctx: SettingsContext = { plugin: this.plugin.configuration?.createUiFacade(this.plugin)??this.plugin, display: () => this.refreshMounted(), syncCancelRef: this.syncCancelRef };
    const renderers: Record<string, (element: HTMLElement, context: SettingsContext) => void> = {
      menus:displayReadingMenuSettings,hotkeys:displayHotkeySettings,assistant:displayAgentConfigurationSettings,
      transfer:element=>{new Setting(element).setName('配置导入 / 导出').setDesc('按模块备份与合并恢复；密钥可选加密携带。').addButton(b=>b.setButtonText('管理配置包').onClick(()=>new ConfigurationTransferModal(this.plugin).open()));},
      precision:element=>{new Setting(element).setName('精细配置').setDesc('查看配置字段并预览修改；与外部智能体使用同一配置服务。').addButton(b=>b.setButtonText('打开').onClick(()=>new ConfigurationEditorModal(this.plugin).open()));},
      help:element=>{new Setting(element).setName('Wiki 与使用指南').addButton(b=>b.setButtonText('打开离线 Wiki').onClick(()=>new HelpModal(this.plugin).open()));},
      credentials: displayCredentialStorageSettings, cli: displayCliSettings, local: displayLocalLlmSettings,
      api: displayApiProviderSettings, jev: displayJevSettings, proxy: displayProxySettings, workspace: displayToolPermissionSettings,
      history: displayChatBehaviorSettings, chat: (element, context) => displayChatSettings(element, context, false),
      okf: displayKnowledgeSettings, edits: displayEditHistorySettings, encryption: displayEncryptionSettings,
      langfuse: displayLangfuseSettings, slash: displaySlashCommandSettings, externalSkills: displayExternalSkillSettings,
      agent: displayAgentPluginSettings, rag: displayRagSettings, mcp: displayMcpServersSettings,
      source: displaySourceIngestSettings, storage: displayStorageSettings,
      requests: displayRequestControls,
      workflow: element => {
        new Setting(element).setName(tr("Open the workflow panel", "打开工作流面板")).addButton(button => button.setButtonText(tr("Open", "打开")).onClick(() => {
          void this.plugin.activateChatView().then(() => { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT)) if (leaf.view instanceof ChatView) leaf.view.setActiveTab("workflow"); });
        }));
        new Setting(element).setName(tr("Edit the Inbox preset", "编辑 Inbox 预设"))
          .setDesc(tr("Presets and scripts remain editable, replaceable and optional.", "预设和脚本可继续修改、替换或关闭。"))
          .addButton(button => button.setButtonText(tr("Open", "打开")).onClick(() => {
            void this.app.workspace.openLinkText(getStoragePaths(this.plugin.settings).tools + "/llmhubpp-inbox/Source-Auto-Ingest.md", "");
          }));
      },
      safeGuard: element => {
        new Setting(element).setName(tr("Safe Guard settings", "安全防护设置")).setDesc(tr("Open the existing protection settings and active runtime.", "打开现有安全防护设置，继续使用当前运行实例。"))
          .addButton(button => button.setButtonText(tr("Open", "打开")).onClick(() => {
            (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById("llmhubpp-safe-guard");
          }));
      },
    };
    renderers[section.id]?.(root, ctx);
    const state = this.viewStates.get(section.id);
    if (state) restoreSettingsViewState(root, state);
  }
  private refreshMounted(): void {
    // Updating only the open sub-page retains the native page and back stack.
    for (const [root, { section }] of this.mounted) {
      if (!root.isConnected) continue;
      this.viewStates.set(section.id, captureSettingsViewState(root));
      this.renderSection(section, root);
    }
  }
  hide(): void {
    for (const [root, { kind }] of this.mounted) if(kind === "page") this.unmountSection(root);
  }
}
