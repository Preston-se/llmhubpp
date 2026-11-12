import {hasMoreRagWork} from './core/ragSyncPass';
import {TaskJournal} from './core/taskJournal';
import {TaskShutdown,installNativeTaskCloseGuard} from './core/taskShutdown';
import {TaskExitModal} from './ui/TaskExitModal';
import { RagNotePrompts } from './ui/RagNotePrompts';
import {describeShellTask,resumeManagedIngest} from './core/managedIngest';
import { configureMcpClientInfo, configureMcpStdioClient } from "obsidian-llm-hub-common/mcp";
import { configureAgentPluginBase } from "obsidian-llm-hub-common/skills";
import { handleCommandNode } from "src/workflow/handlers/command";
import { handleMcpNode } from "src/workflow/handlers/mcp";
import { handleRagSyncNode } from "src/workflow/handlers/ragSync";
import { handleShellNode } from "src/workflow/handlers/shell";
import { setMcpApprovalHandler, sameMcpConnection } from "./core/mcpApproval";
import { McpApprovalModal } from "./ui/components/McpApprovalModal";
import { Plugin, WorkspaceLeaf, Notice, MarkdownView, TFile, Modal, type EventRef, Platform } from "obsidian";
import { registerVaultIndexEvents } from "./host/registerVaultIndexEvents";
import { EventEmitter } from "src/utils/EventEmitter";
import { TaskManager, type WorkControl } from "./core/taskManager";
import { TaskMonitorModal, taskStatusText } from "./ui/TaskMonitorModal";
import type { SelectionLocationInfo } from "src/ui/selectionHighlight";
import { SelectionManager } from "src/plugin/selectionManager";
import { EncryptionManager } from "src/plugin/encryptionManager";
import { WorkflowManager } from "src/plugin/workflowManager";
import { WorkspaceStateManager } from "src/core/workspaceStateManager";
import { ChatView, VIEW_TYPE_GEMINI_CHAT } from "src/ui/ChatView";
import { registerReadingMenuItems, type ReadingContext } from "src/ui/readingContext";
import { HostConfiguration } from "src/configuration/host";
import { installSourceReading, prepareSourceReading, sourceErrorText, type ReadingAction } from "src/ui/sourceReading";
import { SourceIngestCoordinator } from "src/core/sourceIngestCoordinator";
import { RagLifecycle } from "src/core/ragLifecycle";
import { RagIndexTargetModal } from "src/ui/components/RagIndexTargetModal";
import { getRagDocumentStore, forgetRagDocumentStore } from "src/core/ragDocumentStore";
import { generateEmbeddings, generateGeminiNativeEmbeddings } from "src/core/embeddingProvider";
import { resolveEmbeddingConnection } from "src/core/embeddingCredentials";
import { isLocalRequestOrigin } from 'src/core/outboundRequest';
import { DEFAULT_SOURCE_WATCH } from "src/core/sourceWatchPolicy";
import { RequestUsageLedger, DEFAULT_REQUEST_CONTROLS, validateRequestControls, type RequestControls } from 'src/core/requestUsage';
import { configureRequestCapture } from 'src/core/outboundRequest';
import { RequestProtectionChoices } from 'src/core/requestProtectionChoices';
import { RequestProtectionModal } from 'src/ui/components/RequestProtectionModal';
import { RequestPayloadModal } from 'src/ui/components/RequestPayloadModal';
import { SourceDocumentError } from "src/core/sourceDocuments";
import { createStorageLayout, applyStoragePaths, getStoragePaths, isManagedRootExport, managedStorageDirectories } from "src/core/storagePaths";
import { configureRagStorageDirectory } from "src/core/localRagStorage";
import { installWorkflowModalLocalization } from "src/ui/settings/workflowModalLocalization";
import { CryptView, CRYPT_VIEW_TYPE } from "src/ui/CryptView";
import { CliTerminalView, CLI_TERMINAL_VIEW_TYPE } from "src/ui/CliTerminalView";
import { SettingsTab } from "src/ui/SettingsTab";
import { configureWorkflowHost } from "obsidian-llm-hub-common/workflow";
import { getWorkflowModelOptions } from "src/core/workflowModels";
import { configureMcpAppViewer, configureStoragePrefix } from "obsidian-llm-hub-common/modals";
import { showMcpApp } from "src/ui/components/workflow/McpAppModal";
import type { McpAppInfo } from "src/types";
import { streamWorkflowChat } from "src/core/workflowChat";
import { tracing } from "src/core/tracingHooks";
import { getWorkflowSpecification, buildWorkflowSpecContext } from "src/workflow/workflowSpec";
import {
  SKILLS_FOLDER,
  type LlmHubSettings,
  type WorkspaceState,
  type RagSetting,
  type ModelType,
  type SlashCommand,
  type LocalLlmConfig,
  type CliProviderConfig,
  DEFAULT_SETTINGS,
  DEFAULT_LOCAL_LLM_CONFIG,
  getGeminiApiKey,
  normalizeDeprecatedGeminiModelName,
  normalizeDeprecatedModelIdentifier,
} from "src/types";
import { initGeminiClient, resetGeminiClient, getGeminiClient } from "src/core/gemini";
import { initLangfuse, resetLangfuse } from "src/tracing/langfuse";
import { WorkflowSelectorModal } from "src/ui/components/workflow/WorkflowSelectorModal";
import {
  initLocalRagStore,
  resetLocalRagStore,
  getLocalRagStore,
  assertRagSyncReady,
  isGeminiMultimodalEmbeddingModel,
} from "src/core/localRagStore";
import { initCliProviderManager } from "src/core/cliProvider";
import {
  initEditHistoryManager,
  resetEditHistoryManager,
  getEditHistoryManager,
} from "src/core/editHistory";
import { EditHistoryModal } from "src/ui/components/EditHistoryModal";
import { formatError, configureClassPrefix } from "obsidian-llm-hub-common/core";
import { DEFAULT_CLI_CONFIG, DEFAULT_DISCORD_SETTINGS, DEFAULT_EDIT_HISTORY_SETTINGS, DEFAULT_GEMINI_EMBEDDING_MODEL, DEFAULT_LANGFUSE_SETTINGS, DEFAULT_WORKSPACE_FOLDER, hasVerifiedCli, isRagIndexIdleSeconds, RAG_INDEX_IDLE_DEFAULT_SECONDS } from "src/types";
import { initLocale, t } from "src/i18n";
import { registerWorkflowCodeBlockProcessor } from "src/ui/workflowCodeBlock";
import { getSlashCommandSearchSelection } from "src/core/webSearch";
import {
  generateDashboardBase,
  generateDashboardWorkflow,
  listDashboardModels,
  rewriteDashboardText,
  runDashboardWorkflow,
} from "src/integrations/dashboardHubCapabilities";
import {
  REGISTER_RUNTIME_SKILL_EVENT,
  REQUEST_RUNTIME_SKILLS_EVENT,
  UNREGISTER_RUNTIME_SKILL_EVENT,
  registerRuntimeSkill,
  unregisterRuntimeSkill,
} from "src/core/runtimeSkills";
import { registerConnectHubIntegration } from "src/integrations/connectHubCapabilities";
import { registerDiscussionHubIntegration } from "src/integrations/discussionHubCapabilities";
import {
  applySettingsCredentials,
  collectSettingsCredentials,
  mergeConfiguredCredentials,
  stripSettingsCredentials,
  SETTINGS_CREDENTIAL_SECRET_ID,
  type SettingsCredentialBundle,
} from "src/core/credentialBundle";
import { isSecretStorageAvailable, readSecretJson, writeSecretJson } from "src/core/secretStorage";

interface DashboardHubIntegration {
  protocolVersion: 1;
  id: string;
  name: string;
  listModels: () => Promise<Array<{ id: string; name: string; capabilities: { text: boolean; vaultRead: boolean; tools: boolean } }>>;
  getDefaultModel: () => Promise<string | null>;
  openChatWithDraft: (draft: string) => void | Promise<void>;
  askChatAboutSelection: (request: { text: string; sourcePath?: string }) => void | Promise<void>;
  runWorkflow?: (request: { workflowPath: string; outputVariable?: string; abortSignal?: AbortSignal }) => Promise<string>;
  generateBase?: (request: Parameters<typeof generateDashboardBase>[1]) => Promise<string>;
  rewriteText?: (request: Parameters<typeof rewriteDashboardText>[1]) => Promise<string>;
  generateWorkflow?: (request: Parameters<typeof generateDashboardWorkflow>[1]) => Promise<string>;
}

interface DashboardHubApi {
  registerIntegration: (integration: DashboardHubIntegration) => () => void;
  createDashboard: (requestedName?: string) => Promise<TFile | null>;
}

interface DashboardWorkspaceEvents {
  on: (name: "dashboard-hub:ready", callback: (hub: DashboardHubApi) => void) => EventRef;
  trigger: {
    (name: "dashboard-hub:register-integration", integration: DashboardHubIntegration): void;
    (name: "dashboard-hub:unregister-integration", request: { id: string; integration: DashboardHubIntegration }): void;
  };
}

interface DiscussionHubApi {
  openDiscussion: (request?: { theme?: string; attachments?: import("src/types").Attachment[] }) => Promise<void>;
  getConfiguration: () => DiscussionHubConfiguration;
  runDiscussion: (request: {
    theme: string;
    turns?: number;
    participants?: DiscussionHubPerson[];
    voters?: DiscussionHubPerson[];
    abortSignal?: AbortSignal;
  }) => Promise<DiscussionHubResult>;
}

export interface DiscussionHubPerson {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  role?: string;
}

export interface DiscussionHubConfiguration {
  defaultTurns: number;
  participants: DiscussionHubPerson[];
  voters: DiscussionHubPerson[];
}

export interface DiscussionHubResult {
  theme: string;
  turns: Array<{ turnNumber: number; responses: Array<{ displayName: string; content: string; error?: string }> }>;
  conclusions: Array<{ displayName: string; content: string }>;
  votes: Array<{ voterDisplayName: string; votedForDisplayName: string; reason?: string }>;
  winnerId: string | null;
  winnerIds: string[];
  isDraw: boolean;
  finalConclusion: string;
  startTime: number;
  participants: DiscussionHubPerson[];
}

function normaliseCliConfig(loaded: Record<string, unknown>): CliProviderConfig {
  const raw = (loaded.cliConfig ?? {}) as Record<string, unknown>;
  const migrated = raw.antigravityCliMigrated === true;
  const config = {
    ...DEFAULT_CLI_CONFIG,
    ...raw,
    antigravityCliMigrated: true,
  };

  if (!migrated) {
    delete config.geminiCliPath;
    if (raw.cliVerified === true) {
      config.cliVerified = false;
    }
  }

  return config;
}

/**
 * Normalise the Local LLM config stored on disk into the modern array form.
 * Handles three shapes:
 *   1. New:   `localLlmConfigs: LocalLlmConfig[]` — used as-is (with id fill-in)
 *   2. Mixed: array plus legacy fields — array wins, legacy ignored
 *   3. Legacy: `localLlmConfig: {...}` + top-level verified/availableModels —
 *      converted into a single entry in the array.
 * Always returns an array (possibly empty).
 */
/**
 * Seed `enabledModels` from the legacy `model` field when the stored config
 * predates multi-model support, so existing saved selections keep working
 * without the user having to re-pick anything.
 */
function fillEnabledModels(c: Partial<LocalLlmConfig>): string[] {
  if (Array.isArray(c.enabledModels) && c.enabledModels.length > 0) {
    return c.enabledModels;
  }
  return c.model ? [c.model] : [];
}

function normaliseLocalLlmConfigs(loaded: Record<string, unknown>): LocalLlmConfig[] {
  const warnIfEmpty = (entry: LocalLlmConfig, source: string): void => {
    if (entry.verified && entry.enabledModels?.length === 0) {
      // Verified-but-modelless entries get filtered out of the chat dropdown
      // (flatMap returns []), making them invisibly broken. Surface the
      // condition so users / bug reports can correlate.
      console.warn(
        `[llm-hub] Local LLM "${entry.id}" (${source}) has no enabled models; ` +
        `it will not appear in the chat dropdown until a model is selected.`,
      );
    }
  };

  const rawArray = loaded.localLlmConfigs;
  if (Array.isArray(rawArray)) {
    return rawArray.map((entry, i) => {
      const e = entry as Partial<LocalLlmConfig>;
      const normalised: LocalLlmConfig = {
        ...DEFAULT_LOCAL_LLM_CONFIG,
        ...e,
        // Recovery path: a stored array entry without an id. Use a stable
        // index-based id so the same load produces the same id on every
        // restart — references saved against it stay valid.
        id: e.id || `local_recovered_${i}`,
        enabled: e.enabled !== false,
        enabledModels: fillEnabledModels(e),
      };
      warnIfEmpty(normalised, "stored");
      return normalised;
    });
  }

  const legacy = loaded.localLlmConfig as Partial<LocalLlmConfig> | undefined;
  if (legacy && typeof legacy === "object") {
    const verified = Boolean(loaded.localLlmVerified);
    const availableModels = Array.isArray(loaded.localLlmAvailableModels)
      ? (loaded.localLlmAvailableModels as string[])
      : [];
    const migrated: LocalLlmConfig = {
      ...DEFAULT_LOCAL_LLM_CONFIG,
      ...legacy,
      // Use a deterministic id so workspace state / discussion participants
      // / Discord conversations that get saved against this migrated entry
      // keep resolving across restarts. Without this, every loadSettings()
      // would mint a new `Date.now()` id and orphan those saved references.
      id: legacy.id || "local_legacy",
      verified,
      availableModels,
      enabled: true,
      enabledModels: fillEnabledModels(legacy),
    };
    warnIfEmpty(migrated, "legacy migration");
    return [migrated];
  }

  return [];
}

function normalizeModelSetting<T>(model: T): T {
  return typeof model === "string"
    ? normalizeDeprecatedModelIdentifier(model) as T
    : model;
}

function normalizeModelList(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(models
    .filter((model): model is string => typeof model === "string")
    .map(normalizeDeprecatedGeminiModelName)));
}

export class LlmHubPlugin extends Plugin {
  sourceIngest?: SourceIngestCoordinator;
  ragLifecycle?: RagLifecycle;
  requestUsage?: RequestUsageLedger;
  requestUsageError?: string;
  private storageStatePath?: string;
  private readingActionSequence = 0;
  /** Allows the unified entry to start protection after settings/workspace initialization. */
  ready: Promise<void> = Promise.resolve();
  tasks = new TaskManager();
  private taskMonitor?: TaskMonitorModal;
  private taskExitModal?: TaskExitModal;
  private ragNotePrompts?: RagNotePrompts;
  settings: LlmHubSettings = { ...DEFAULT_SETTINGS };
  settingsEmitter = new EventEmitter();
  private wsManager!: WorkspaceStateManager;
  configuration?: HostConfiguration;
  configurationRecoveryMode=false;

  async initializeConfiguration(): Promise<void> {
    const configuration = new HostConfiguration(this);
    await configuration.initialize();
    this.configuration = configuration;
  }

  setWorkspaceConfigurationSaver(save: (value: WorkspaceState) => Promise<void>): void {
    this.wsManager.configurationSaver = save;
  }

  persistWorkspaceConfiguration(): Promise<void> { return this.wsManager.persistWorkspaceState(); }
  activateWorkspaceConfiguration(): void {
    const store=getLocalRagStore();
    store?.setSettings(this.workspaceState.ragSettings);
    for(const [name,setting]of Object.entries(this.workspaceState.ragSettings)){store?.setExternalPath(name,setting.externalIndexPath);store?.setSourceRagSettings(name,setting.sourceRagSettings);}
  }
  peekRagConfigurationStatus(name:string):Record<string,unknown>|undefined{
    const state=getLocalRagStore()?.peekConfigurationStatus(name),cached=state?.cached as Record<string,unknown>|undefined,setting=this.workspaceState.ragSettings[name];
    const queue = this.ragLifecycle?.status(name);
    const indexing = queue && { waiting: queue.waiting, ready: queue.ready, deferred: queue.deferred,
      running: queue.running ? 1 : 0, failed: queue.failed, nextReadyAt: queue.nextReadyAt, connection: this.indexDestinationStatus(name) };
    return state || indexing ? { ...state, indexing, needsReindex:cached&&setting&&['embeddingModel','chunkSize','chunkOverlap'].some(key=>cached[key]!==Reflect.get(setting,key))?true:'unknown' } : undefined;
  }
  private selectionManager!: SelectionManager;
  private encryptionManager!: EncryptionManager;
  private lastActiveMarkdownView: MarkdownView | null = null;
  private workflowMgr!: WorkflowManager;
  /** In-memory only – cleared on Obsidian restart */
  lastActiveChatId: string | null = null;

  // Delegate workspaceState to the manager
  get workspaceState(): WorkspaceState {
    return this.wsManager.workspaceState;
  }
  set workspaceState(value: WorkspaceState) {
    this.wsManager.workspaceState = value;
  }

  onload(): void | Promise<void> {
    try {
      this.onloadImpl();
    } catch (e) {
      // Mobile has no readable console: surface startup failures via a
      // persistent Notice and a log file in the vault.
      // JavaScriptCore's error.stack omits the message, so include both explicitly.
      const msg = `LLM Hub: onload failed: ${String(e)}\n${e instanceof Error ? e.stack ?? "" : ""}`;
      new Notice(msg, 0);
      void this.app.vault.adapter.write("llm-hub-load-error.log", msg).catch(() => {});
      throw e;
    }
  }

  openTaskMonitor(): void {
    this.taskMonitor?.close();
    this.taskMonitor = new TaskMonitorModal(this.app, this.tasks, this.ragLifecycle);
    this.taskMonitor.open();
  }

  private onloadImpl(): void {
    let active = true;
    this.register(() => { active = false; });
    initLocale();
    const status = this.addStatusBarItem();
    status.addClass("llm-hub-task-status-bar");
    status.setAttribute("role", "button");
    status.tabIndex = 0;
    const refreshTaskStatus = () => {
      const summary = taskStatusText(this.tasks.list(), this.ragLifecycle?.listPendingIndexTasks() ?? []);
      status.setText(summary);
      status.setAttribute("aria-label", `${t("taskMonitor.open")} · ${summary}`);
    };
    let taskTimer: number | undefined;
    const scheduleTaskStatus = () => {
      if (!active || taskTimer !== undefined) return;
      taskTimer = window.setTimeout(() => { taskTimer = undefined; refreshTaskStatus(); }, 100);
    };
    this.register(this.tasks.subscribe(scheduleTaskStatus));
    this.register(() => { if (taskTimer !== undefined) window.clearTimeout(taskTimer); });
    this.register(() => this.taskMonitor?.close());
    this.registerDomEvent(status, "click", () => this.openTaskMonitor());
    this.registerDomEvent(status, "keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openTaskMonitor();
    });
    refreshTaskStatus();
    configureClassPrefix("llm-hub");
    configureStoragePrefix("llm-hub");
    configureAgentPluginBase(".llm-hub");
    configureMcpClientInfo({ name: "obsidian-llm-hub", version: this.manifest.version });
    // Desktop-only: registering it here keeps Node's child_process off the mobile startup path.
    if (!Platform.isMobile) {
      configureMcpStdioClient((config) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load the stdio transport only where it can run.
        const { McpStdioClient } = require("src/core/mcpStdioClient") as typeof import("src/core/mcpStdioClient");
        return new McpStdioClient(config);
      });
    }
    configureWorkflowHost({
      getModelOptions: () => getWorkflowModelOptions(this.settings),
      getCurrentModel: () => this.getSelectedModel(),
      getLastWorkflowModel: () => this.settings.lastAIWorkflowModel,
      setLastWorkflowModel: (model) => {
        this.settings.lastAIWorkflowModel = model;
        void this.saveSettings();
      },
      getRagSettingNames: () => Object.keys(this.workspaceState.ragSettings || {}),
      getMcpServerNames: () => (this.settings.mcpServers || []).map(server => server.name),
      getWorkflowSpecification: () => getWorkflowSpecification(buildWorkflowSpecContext(this)),
      getWorkspaceFolder: () => this.settings.workspaceFolder,
      getSkillsFolder: () => this.settings.skillsFolder || SKILLS_FOLDER,
      notifySkillsChanged: () => this.settingsEmitter.emit("skills-changed"),
      getHistoryEncryption: () => this.settings.encryption,
      getPluginVersion: () => this.manifest.version,
      getWorkflowHotkeys: () => this.settings.enabledWorkflowHotkeys,
      setWorkflowHotkeys: (paths) => {
        this.settings.enabledWorkflowHotkeys = paths;
        void this.saveSettings();
      },
      getWorkflowEventTriggers: () => this.settings.enabledWorkflowEventTriggers,
      setWorkflowEventTriggers: (triggers) => {
        this.settings.enabledWorkflowEventTriggers = triggers;
        void this.saveSettings();
      },
      runWorkflowFromHotkey: (path) => {
        void this.executeWorkflowFromHotkey(path);
      },
      getLastSelectedWorkflow: () => this.settings.lastSelectedWorkflowPath,
      setLastSelectedWorkflow: (path) => {
        this.settings.lastSelectedWorkflowPath = path;
        void this.saveSettings();
      },
      streamChat: (request) => streamWorkflowChat(this, request),
      runCommandNode: ({ node, context, app, callbacks, traceId, abortSignal }) =>
        handleCommandNode(node, context, app, this, callbacks, traceId, abortSignal),
      runMcpNode: ({ node, context, app }) => handleMcpNode(node, context, app, this),
      runShellNode: async ({ node, context, app, abortSignal }) => {
        const descriptor=await describeShellTask(app,node,context,this.manifest.dir||'',this.workspaceState.selectedRagSetting||'');
        return this.tasks.run("文件转换/脚本", task => handleShellNode(node, context, app, task), {signal: abortSignal, source: String(context.variables.get("_eventFilePath") || node.properties["command"] || ""),descriptor});
      },
      runRagSyncNode: ({ node, context, app, abortSignal }) => handleRagSyncNode(node, context, app, this, abortSignal),
      tracing,
    });
    configureMcpAppViewer((app, mcpApp) => showMcpApp(app, mcpApp as McpAppInfo));

    let approvalModal: McpApprovalModal | undefined;
    setMcpApprovalHandler({
      getServer: server => this.settings.mcpServers.find(saved => sameMcpConnection(saved, server) && saved.name === server.name)
        ?? (server.name === server.url ? this.settings.mcpServers.find(saved => sameMcpConnection(saved, server)) : undefined),
      request: async (server, tool, args, canRemember) => {
        approvalModal = new McpApprovalModal(this.app, server, tool, args, canRemember);
        try {
          return await approvalModal.openAndWait();
        } finally {
          approvalModal = undefined;
        }
      },
      remember: async (server, tool) => {
        const previous = server.allowedTools;
        server.allowedTools = [...new Set([...(previous ?? []), tool])];
        try {
          await this.saveSettings();
        } catch (error) {
          server.allowedTools = previous;
          throw Object.assign(new Error("MCP tool approval could not be saved"), { cause: error });
        }
      },
    });
    this.register(() => {
      setMcpApprovalHandler(undefined);
      approvalModal?.close();
    });

    // Initialize selection manager
    this.selectionManager = new SelectionManager(this);

    // Initialize encryption manager
    this.encryptionManager = new EncryptionManager(this);

    // Initialize workflow manager
    this.workflowMgr = new WorkflowManager(this, this.selectionManager);

    // Workflow code block: render as Mermaid diagram (Reading mode + Live Preview)
    registerWorkflowCodeBlockProcessor(this);

    // Initialize workspace state manager
    this.wsManager = new WorkspaceStateManager(
      this.app,
      () => this.settings,
      this.settingsEmitter,
      () => this.loadData()
    );

    // Handle migration data modified event
    this.settingsEmitter.on("migration-data-modified", (data: unknown) => {
      void (async () => {
        await this.saveData(data);
      })();
    });

    // Load settings and workspace state
    this.ready = this.loadSettings().then(async () => {
      if (!active || this.configurationRecoveryMode) return;
      this.requestUsage = new RequestUsageLedger(this.app.vault.adapter, getStoragePaths(this.settings, this.app.vault.configDir).tasks+'/usage',()=>this.getRequestControls());
      this.requestProtectionChoices = new RequestProtectionChoices(this.app.vault.adapter, this.requestUsage.directory+'/protection-choices.json', async scope => {
        const modal = new RequestProtectionModal(this.app, scope); this.register(() => modal.close()); return modal.openAndWait();
      });
      configureRequestCapture({ledger:this.requestUsage,settings:()=>this.getRequestControls(),exception:scope=>this.requestProtectionChoices!.allow(scope),confirm:async(origin,payload)=>{
        const modal=new RequestPayloadModal(this.app,origin,payload);this.register(()=>modal.close());return modal.openAndWait();
      },warn:text=>new Notice(text)});
      this.register(()=>configureRequestCapture(undefined));
      try{await this.requestUsage.initialize();}catch{this.requestUsageError='费用记录损坏，受控 API 请求已停止。请检查本地费用记录。';new Notice(this.requestUsageError);}
      this.sourceIngest = new SourceIngestCoordinator({ app: this.app, tasks: this.tasks,
        manifestDirectory: getStoragePaths(this.settings, this.app.vault.configDir).sources,
        policy: () => this.settings.sourceWatch ?? DEFAULT_SOURCE_WATCH, workspace: () => this.settings.workspaceFolder,
        managedDirectories: () => managedStorageDirectories(getStoragePaths(this.settings, this.app.vault.configDir)),
        isManagedFile: path => isManagedRootExport(this.app.vault.adapter, getStoragePaths(this.settings, this.app.vault.configDir), path),
        ensureIndex: (name, owner, exists) => this.wsManager.ensureSourceRagSetting(name, owner, exists),
        sync: (name, paths, control) => this.performRagSync(name, undefined, control, paths),
      });
      this.register(() => this.sourceIngest?.dispose());
      const recovered=await this.tasks.initialize(new TaskJournal(this.app.vault.adapter,getStoragePaths(this.settings, this.app.vault.configDir).tasks),async(descriptor,task)=>{
        if(descriptor.kind==='rag')return this.performRagSync(descriptor.setting||'',undefined,task);
        if(descriptor.kind==='source')return this.sourceIngest!.resume(descriptor.source || '', task);
        if(descriptor.kind==='ingest'){
          await resumeManagedIngest(this.app,this.manifest.dir||'',descriptor,task);
          if(descriptor.setting)await this.syncVaultForLocalRAG(descriptor.setting,undefined,task.signal,descriptor.source||'');
          return;
        }
        throw new Error('自定义脚本不能自动重放，请检查原工作流');
      });
      if(recovered)new Notice(`已恢复 ${recovered} 个未完成任务，保持暂停；点击右下角任务状态继续`,10000);
      if(!Platform.isMobile){
        const close=()=>{(window as unknown as {require:(id:string)=>{remote:{getCurrentWindow:()=>{close:()=>void}}}}).require('electron').remote.getCurrentWindow().close();};
        const prompt = async (): Promise<boolean> => {
          const indexChoice = await this.ragNotePrompts?.beforeExit();
          if (indexChoice !== undefined) return indexChoice;
          if (!this.tasks.hasUnfinished()) return true;
          return new Promise(resolve => { this.taskExitModal = new TaskExitModal(this.app, resolve); this.taskExitModal.open(); });
        };
        const shutdown=new TaskShutdown(()=>this.tasks.hasUnfinished() || !!this.ragNotePrompts?.hasWork(),prompt,()=>this.tasks.suspendAll(),close,error=>new Notice(`保存失败，未退出：${error instanceof Error?error.message:String(error)}`,0),()=>{const w=(window as unknown as {require:(id:string)=>{remote:{getCurrentWindow:()=>{show:()=>void;focus:()=>void}}}}).require('electron').remote.getCurrentWindow();w.show();w.focus();});
        this.registerDomEvent(window,'beforeunload',event=>shutdown.onClose(event),true);
        this.register(installNativeTaskCloseGuard(shutdown));
        this.register(()=>{shutdown.dispose();this.taskExitModal?.close();});
        this.registerEvent(this.app.workspace.on('quit',tasks=>tasks.addPromise(this.tasks.suspendAll())));
      }

      // Apply workspace folder visibility (body class toggle)
      this.updateWorkspaceFolderVisibility();

      // Migrate from old settings format first (one-time)
      try {
        await this.wsManager.migrateFromOldSettings();
      } catch (e) {
        console.error("LLM Hub: Failed to migrate old settings:", formatError(e));
      }
      try {
        await this.wsManager.loadWorkspaceState();
      } catch (e) {
        console.error("LLM Hub: Failed to load workspace state:", formatError(e));
      }
      if (!active) return;
      const queueSource = (file: unknown) => {
        if (file instanceof TFile) void this.sourceIngest?.enqueue(file.path).catch(error => new Notice(sourceErrorText(error)));
      };
      const localRag = initLocalRagStore();
      localRag.workspaceFolder = this.settings.workspaceFolder;
      await localRag.load(this.app, Object.keys(this.workspaceState.ragSettings), this.workspaceState.ragSettings);
      if (!active) return;
      this.ragLifecycle = new RagLifecycle({
        app: this.app, tasks: this.tasks, settings: () => this.workspaceState.ragSettings,
        workspace: () => this.settings.workspaceFolder,
        managedDirectories: () => managedStorageDirectories(getStoragePaths(this.settings, this.app.vault.configDir)),
        base: name => localRag.getSnapshot(this.app, name),
        idleSeconds: () => this.settings.ragIndexIdleSeconds,
        canRunAutomatic: name => this.indexDestinationStatus(name) === 'ready',
        embed: async (name, inputs, control, automatic) => {
          const setting = this.getRagSetting(name);
          if (!setting) throw new Error('索引配置不存在');
          const connection = resolveEmbeddingConnection(setting, this.settings);
          const model = setting.embeddingModel || (connection.kind === 'gemini' ? DEFAULT_GEMINI_EMBEDDING_MODEL : '');
          if (connection.status !== 'ready' || !model) throw new Error('请先配置本地嵌入模型，或明确选择云端模型');
          const allowed = automatic ? this.indexDestinationStatus(name) === 'ready'
            : await this.confirmKnowledgeDestination('index', connection.destination, name, model);
          if (!allowed) throw new Error('当前设置暂停了远程索引更新');
          await control.checkpoint();
          if (connection.kind === 'custom') {
            const texts = inputs.map(input => { if (typeof input !== 'string') throw new Error('此嵌入服务需要先提取文本'); return input; });
            return generateEmbeddings(texts, connection.apiKey, model, connection.baseUrl, this.settings.proxyUrl, this.settings.proxyBypass, control);
          }
          return generateGeminiNativeEmbeddings(inputs.map(input => typeof input === 'string' ? { text: input } : { inlineData: input }), connection.apiKey, model, undefined, this.settings.proxyUrl, this.settings.proxyBypass, control);
        },
      });
      const lifecycle = this.ragLifecycle;
      this.register(lifecycle.observe(scheduleTaskStatus));
      this.taskMonitor?.setLifecycle(lifecycle);
      const indexingReady = await registerVaultIndexEvents(this, {
        initialize: () => lifecycle.initialize(),
        dispose: () => lifecycle.dispose(),
        managedDirectories: () => managedStorageDirectories(getStoragePaths(this.settings, this.app.vault.configDir)),
        changed: (kind, path, oldPath) => lifecycle.changed(kind, path, oldPath),
        onError: error => console.warn("索引事件处理失败", formatError(error)),
      });
      if (!indexingReady || !active) return;
      this.ragNotePrompts = new RagNotePrompts(this, this.ragLifecycle, () => this.settings.ragContinueAfterClose, () => this.tasks.hasUnfinished());
      const refreshDestinations = () => { void this.refreshIndexDestinations().catch(() => new Notice('无法读取索引的远程发送选择，请在设置中检查。')); };
      this.settingsEmitter.on('settings-updated', refreshDestinations);
      this.register(() => { this.settingsEmitter.off('settings-updated', refreshDestinations); });
      refreshDestinations();
      this.app.workspace.onLayoutReady(() => {
        for (const [name, setting] of Object.entries(this.workspaceState.ragSettings)) {
          if (setting.autoUpdateIndex && !setting.externalIndexPath && !setting.sourceRagSettings.length && !setting.sourceCollection)
            void this.ragLifecycle?.reconcile(name, undefined, true).catch(error => console.warn('自动索引校核失败', formatError(error)));
        }
      });
      this.registerEvent(this.app.vault.on("create", queueSource));
      this.registerEvent(this.app.vault.on("modify", queueSource));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && this.settings.sourceWatch?.enabled) void this.sourceIngest?.rename(file.path, oldPath).catch(error => new Notice(sourceErrorText(error)));
      }));
      // Migrate slash commands (add default commands if missing)
      try {
        await this.migrateSlashCommands();
      } catch (e) {
        console.error("LLM Hub: Failed to migrate slash commands:", formatError(e));
      }
      // Initialize clients if any CLI is verified or any API provider is configured
      try {
        const cliConfig = this.settings.cliConfig || DEFAULT_CLI_CONFIG;
        const anyLocalLlmVerified = this.settings.localLlmConfigs?.some(c => c.verified) ?? false;
        if (hasVerifiedCli(cliConfig) || anyLocalLlmVerified || this.settings.apiProviders?.some(p => p.enabled && p.verified)) {
          this.initializeClients();
        }
      } catch (e) {
        console.error("LLM Hub: Failed to initialize clients:", formatError(e));
      }
      // Register workflows as Obsidian commands for hotkey support
      try {
        this.registerWorkflowHotkeys();
      } catch (e) {
        console.error("LLM Hub: Failed to register workflow hotkeys:", formatError(e));
      }
      // Register event listeners for workflow triggers
      try {
        this.registerWorkflowEventListeners();
      } catch (e) {
        console.error("LLM Hub: Failed to register workflow event listeners:", formatError(e));
      }
      this.app.workspace.onLayoutReady(() => {
        void this.workflowMgr.triggerStartupWorkflows();
      });
      // Emit event to refresh UI after workspace state is loaded
      this.settingsEmitter.emit("workspace-state-loaded", this.workspaceState);
      // Notify UI components that settings are ready (fixes race condition where
      // ChatView renders before loadSettings() completes, e.g. after BRAT hot-reload)
      this.settingsEmitter.emit("settings-updated", this.settings);
      this.notifyDashboardHubMigration();
      registerConnectHubIntegration(this);
    }).catch((e) => {
      console.error("LLM Hub: Failed to load settings:", formatError(e));
    });

    // Add settings tab
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerRuntimeSkillContributions();
    this.registerDashboardHubIntegration();
    registerDiscussionHubIntegration(this);
    // Compatibility command: preserve existing hotkeys while Dashboard Hub
    // remains the sole owner of .dashboard files and dashboard creation.
    this.addCommand({
      id: "create-dashboard",
      name: t("command.createDashboard"),
      callback: () => { void this.createDashboard(); },
    });
    this.addCommand({
      id: "open-discussion-hub",
      name: "Open Discussion Hub",
      callback: () => { void this.openDiscussionHub(); },
    });

    // Register chat view
    this.registerView(
      VIEW_TYPE_GEMINI_CHAT,
      (leaf) => new ChatView(leaf, this)
    );

    // Register crypt view (for encrypted files)
    this.registerView(
      CRYPT_VIEW_TYPE,
      (leaf) => new CryptView(leaf, this)
    );

    // Register terminal view for full TTY CLI sessions
    this.registerView(
      CLI_TERMINAL_VIEW_TYPE,
      (leaf) => new CliTerminalView(leaf, this)
    );

    // Register .encrypted extension so Obsidian opens these files in CryptView
    // Wrapped in try-catch to avoid conflict when another plugin already registered this extension
    try {
      this.registerExtensions(["encrypted"], CRYPT_VIEW_TYPE);
    } catch {
      // Extension already registered by another plugin — skip
    }

    // Register file menu (right-click) for encryption and edit history
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile) {
          for (const force of [false, true]) menu.addItem(item => item.setTitle(t(force ? 'index.forceNote' : 'index.updateNote')).setIcon('database')
            .onClick(() => this.chooseNoteIndex(file.path, force)));
        }
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle(t("crypt.encryptFile"))
              .setIcon("lock")
              .onClick(async () => {
                await this.encryptFile(file);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle(t("statusBar.snapshot"))
              .setIcon("camera")
              .onClick(async () => {
                await this.saveSnapshotForFile(file);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle(t("statusBar.history"))
              .setIcon("history")
              .onClick(() => {
                new EditHistoryModal(this.app, file.path).open();
              });
          });
        }
      })
    );

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      if (!(view instanceof MarkdownView)) return;
      registerReadingMenuItems(menu, editor, view, {
        search: context => { void this.openReadingAction(context, "search"); },
        current: context => { void this.openReadingAction(context, "current"); },
        knowledge: context => { void this.openReadingAction(context, "knowledge"); },
      },this.settings.readingMenus);
    }));
    installSourceReading(this, (context, action) => { void this.openReadingAction(context, action); },()=>this.settings.readingMenus);
    installWorkflowModalLocalization(this);

    // Ensure chat view exists on layout ready
    this.app.workspace.onLayoutReady(() => {
      void this.ensureChatViewExists();
    });

    // Track active markdown view and capture selection when switching to chat
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view?.getViewType() === VIEW_TYPE_GEMINI_CHAT) {
          // Capture selection from the last active markdown view
          this.captureSelectionFromView(this.lastActiveMarkdownView);
          // Notify Chat component that it's now active
          this.settingsEmitter.emit("chat-activated");
        } else {
          // Leaving chat view - clear the highlight
          this.clearSelectionHighlight();
          if (leaf?.view instanceof MarkdownView) {
            // Track the last active markdown view
            this.lastActiveMarkdownView = leaf.view;
          }
        }
      })
    );

    // Add ribbon icon
    this.addRibbonIcon("brain-circuit", "Open chat", () => {
      void this.activateChatView();
    });

    // Add command to open chat
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => {
        void this.activateChatView();
      },
    });

    // Add command to toggle between chat and markdown view
    this.addCommand({
      id: "toggle-chat",
      name: "Toggle chat / editor",
      callback: () => {
        this.toggleChatView();
      },
    });

    // Add command to open a real TTY-backed CLI terminal in the vault root
    this.addCommand({
      id: "open-cli-terminal",
      name: "Open CLI terminal",
      callback: () => {
        void this.activateCliTerminalView();
      },
    });

    // Add command to show edit history
    this.addCommand({
      id: "show-edit-history",
      name: t("command.showEditHistory"),
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          if (!checking) {
            new EditHistoryModal(this.app, activeFile.path).open();
          }
          return true;
        }
        return false;
      },
    });

    // Add command to restore previous version
    this.addCommand({
      id: "restore-previous-version",
      name: t("command.restorePreviousVersion"),
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          if (!checking) {
            void this.restorePreviousVersion(activeFile.path);
          }
          return true;
        }
        return false;
      },
    });

    // Add command to encrypt current file
    this.addCommand({
      id: "encrypt-file",
      name: t("command.encryptFile"),
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === "md") {
          if (!checking) {
            void this.encryptFile(activeFile);
          }
          return true;
        }
        return false;
      },
    });

    // Add command to decrypt current file
    this.addCommand({
      id: "decrypt-file",
      name: t("command.decryptFile"),
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && (activeFile.extension === "md" || activeFile.extension === "encrypted")) {
          if (!checking) {
            void this.decryptCurrentFile(activeFile);
          }
          return true;
        }
        return false;
      },
    });

    // Add command to run workflow
    this.addCommand({
      id: "run-workflow",
      name: t("command.runWorkflow"),
      callback: () => {
        new WorkflowSelectorModal(this.app, (filePath) => {
          void this.executeWorkflowFromHotkey(filePath);
        }).open();
      },
    });

    // Register file events for edit history
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          const historyManager = getEditHistoryManager();
          if (historyManager) {
            historyManager.handleFileRename(oldPath, file.path);
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          const historyManager = getEditHistoryManager();
          if (historyManager) {
            historyManager.handleFileDelete(file.path);
          }
        }
      })
    );

    // Initialize snapshot when a file is opened (for edit history)
    // Also check if .md file is encrypted and redirect to CryptView
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile) {
          if (file.extension === "md") {
            const historyManager = getEditHistoryManager();
            if (historyManager) {
              void historyManager.initSnapshot(file.path);
            }

            // Check if file is encrypted and redirect to CryptView
            void this.checkAndOpenEncryptedFile(file);
          }
        }
      })
    );

  }

  /**
   * Save a snapshot for a specific file
   */
  private async saveSnapshotForFile(file: TFile): Promise<void> {
    const historyManager = getEditHistoryManager();
    if (!historyManager) {
      new Notice(t("editHistory.notInitialized"));
      return;
    }

    await historyManager.ensureSnapshot(file.path);
    const entry = historyManager.saveEdit({
      path: file.path,
      modifiedContent: await this.app.vault.read(file),
      source: "manual",
    });

    if (entry) {
      new Notice(t("statusBar.snapshotSaved"));
    } else {
      new Notice(t("editHistory.noChanges"));
    }
  }

  private async restorePreviousVersion(filePath: string): Promise<void> {
    const historyManager = getEditHistoryManager();
    if (!historyManager) {
      new Notice("Edit history manager not initialized");
      return;
    }

    const history = historyManager.getHistory(filePath);
    if (history.length === 0) {
      new Notice(t("editHistoryModal.noHistory"));
      return;
    }

    // Get the most recent entry and restore to before that change
    const lastEntry = history[history.length - 1];

    // Show confirmation modal
    const confirmed = await new Promise<boolean>((resolve) => {
      const modal = new Modal(this.app);
      modal.contentEl.createEl("p", { text: t("editHistoryModal.confirmRestore") });
      const buttonContainer = modal.contentEl.createDiv({ cls: "modal-button-container" });
      buttonContainer.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => {
        modal.close();
        resolve(false);
      });
      buttonContainer.createEl("button", { text: t("common.confirm"), cls: "mod-warning" }).addEventListener("click", () => {
        modal.close();
        resolve(true);
      });
      modal.open();
    });

    if (confirmed) {
      await historyManager.restoreTo(filePath, lastEntry.id);
      const date = new Date(lastEntry.timestamp);
      const timeStr = date.toLocaleString();
      new Notice(t("editHistoryModal.restored", { timestamp: timeStr }));
    }
  }

  onunload(): void {
    this.tasks.dispose();
    this.clearSelectionHighlight();
    resetLangfuse();
    resetGeminiClient();
    resetLocalRagStore();
    resetEditHistoryManager();

    // Restore workspace folder visibility on unload
    document.body.classList.remove("llm-hub-hide-workspace-folder");

    // Clean up workflow timers
    this.workflowMgr.cleanup();

  }

  async loadSettings(): Promise<void> {
    const savedData = await this.loadData() as Partial<LlmHubSettings> | null;
    const isExistingInstall = savedData !== null && Object.keys(savedData).length > 0;
    const loaded = savedData ?? {};

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      ragIndexIdleSeconds: isRagIndexIdleSeconds(loaded.ragIndexIdleSeconds) ? loaded.ragIndexIdleSeconds : RAG_INDEX_IDLE_DEFAULT_SECONDS,
      sourceWatch: { ...DEFAULT_SOURCE_WATCH, ...loaded.sourceWatch, folderPatterns: [...(loaded.sourceWatch?.folderPatterns ?? DEFAULT_SOURCE_WATCH.folderPatterns)] },
      voiceChat: { ...DEFAULT_SETTINGS.voiceChat, ...loaded.voiceChat },
      maxSavedChatHistories: loaded.maxSavedChatHistories
        ?? (isExistingInstall ? 0 : DEFAULT_SETTINGS.maxSavedChatHistories),
      skillsFolder: typeof loaded.skillsFolder === "string"
        ? loaded.skillsFolder
        : (typeof loaded.skillsFolderPath === "string" ? loaded.skillsFolderPath : DEFAULT_SETTINGS.skillsFolder),
      // Explicitly clear the pre-migration key so it doesn't get persisted back by saveSettings.
      skillsFolderPath: undefined,
      cliConfig: normaliseCliConfig(loaded),
      // Deep copy arrays to avoid mutating DEFAULT_SETTINGS
      // Use loaded commands if present, otherwise use default commands
      slashCommands: loaded.slashCommands
        ? loaded.slashCommands.map(cmd => {
            const searchSelection = getSlashCommandSearchSelection(cmd);
            const { searchSetting: _legacySearchSetting, ...rest } = cmd;
            return {
              ...rest,
              model: normalizeModelSetting(cmd.model),
              searchSelection,
            };
          })
        : [...DEFAULT_SETTINGS.slashCommands],
      // Deep copy API providers (ensure enabledModels exists)
      apiProviders: loaded.apiProviders
        ? loaded.apiProviders.map(p => ({
            ...p,
            enabledModels: normalizeModelList(p.enabledModels),
            availableModels: normalizeModelList(p.availableModels),
          }))
        : [],
      // Deep copy MCP servers (add default transport for backward compatibility)
      mcpServers: loaded.mcpServers
        ? loaded.mcpServers.map(s => ({
            ...s,
            transport: s.transport || "http",
          }))
        : [],
      agentPlugins: Array.isArray(loaded.agentPlugins) ? loaded.agentPlugins : [],
      // Deep copy workflow arrays
      enabledWorkflowHotkeys: loaded.enabledWorkflowHotkeys
        ? [...loaded.enabledWorkflowHotkeys]
        : [],
      enabledWorkflowEventTriggers: loaded.enabledWorkflowEventTriggers
        ? [...loaded.enabledWorkflowEventTriggers]
        : [],
      cloudVaultToolAllowedFolders: Array.isArray(loaded.cloudVaultToolAllowedFolders)
        ? loaded.cloudVaultToolAllowedFolders.map((folder: unknown) => String(folder).trim()).filter(Boolean)
        : [],
      // Deep merge editHistory settings
      editHistory: {
        ...DEFAULT_EDIT_HISTORY_SETTINGS,
        ...(loaded.editHistory ?? {}),
        diff: {
          ...DEFAULT_EDIT_HISTORY_SETTINGS.diff,
          ...(loaded.editHistory?.diff ?? {}),
        },
      },
      // Deep merge langfuse settings
      langfuse: {
        ...DEFAULT_LANGFUSE_SETTINGS,
        ...(loaded.langfuse ?? {}),
      },
      // Local LLM settings — normalised to an array of entries. Legacy
      // singleton (`localLlmConfig`) is migrated into the array on first load.
      localLlmConfigs: normaliseLocalLlmConfigs(loaded),
      // Explicitly clear the pre-migration keys so they don't get persisted
      // back by saveSettings (which diffs against DEFAULT_SETTINGS).
      localLlmConfig: undefined,
      localLlmVerified: undefined,
      localLlmAvailableModels: undefined,
      // Deep merge Discord settings
      discord: {
        ...DEFAULT_DISCORD_SETTINGS,
        ...(loaded.discord ?? {}),
        model: normalizeModelSetting(loaded.discord?.model ?? DEFAULT_DISCORD_SETTINGS.model),
      },
    };
    this.settings.storageLayout = createStorageLayout(savedData, this.app.vault.configDir);
    const storagePaths = applyStoragePaths(this.settings, this.app.vault.configDir);
    this.storageStatePath = storagePaths.state;
    configureRagStorageDirectory(storagePaths.workspace, storagePaths.rag);
    this.settings.lastAIWorkflowModel = normalizeModelSetting(this.settings.lastAIWorkflowModel);
    this.settings.lastTimelineAiModel = normalizeModelSetting(this.settings.lastTimelineAiModel);

    // Overlay credentials held in SecretStorage. This runs in both storage modes
    // so that a device still holding the secrets can recover values that another
    // device stripped from data.json.
    const stored = readSecretJson<SettingsCredentialBundle>(this.app, SETTINGS_CREDENTIAL_SECRET_ID);
    if (stored) applySettingsCredentials(this.settings, stored);
  }

  /** True when new credential writes should go to Obsidian's SecretStorage. */
  isSecretCredentialStorage(): boolean {
    return this.settings.credentialStorage === "secretStorage" && isSecretStorageAvailable(this.app);
  }

  /**
   * Hint shown next to an empty credential field when that slot is known to be
   * configured on another device.
   */
  credentialConfiguredElsewhere(slot: string, currentValue: string | undefined): boolean {
    if (!this.isSecretCredentialStorage()) return false;
    if (currentValue) return false;
    return this.settings.configuredCredentials?.includes(slot) ?? false;
  }

  async saveSettings() {
    const storagePaths = applyStoragePaths(this.settings, this.app.vault.configDir);
    configureRagStorageDirectory(storagePaths.workspace, storagePaths.rag);
    // Credentials go to SecretStorage first: if that write fails we keep the
    // plaintext copy rather than stripping away the only copy we have.
    let settingsForPersistence = this.settings;
    if (this.isSecretCredentialStorage()) {
      const stored = writeSecretJson(
        this.app,
        SETTINGS_CREDENTIAL_SECRET_ID,
        collectSettingsCredentials(this.settings),
      );
      if (stored) {
        this.settings.configuredCredentials = mergeConfiguredCredentials(
          this.settings,
          this.settings.configuredCredentials,
        );
        settingsForPersistence = stripSettingsCredentials(this.settings);
      } else {
        new Notice(t("settings.credentialStorage.writeFailed"), 10000);
      }
    } else if (this.settings.configuredCredentials) {
      this.settings.configuredCredentials = undefined;
    }

    // Only save values that differ from defaults
    const dataToSave: Partial<LlmHubSettings> = {};
    for (const key of Object.keys(settingsForPersistence) as (keyof LlmHubSettings)[]) {
      const currentValue = settingsForPersistence[key];
      const defaultValue = DEFAULT_SETTINGS[key];
      // Use JSON.stringify for arrays/objects comparison
      const isDifferent = Array.isArray(currentValue) || (typeof currentValue === 'object' && currentValue !== null)
        ? JSON.stringify(currentValue) !== JSON.stringify(defaultValue)
        : currentValue !== defaultValue;
      if (isDifferent) {
        (dataToSave as Record<string, unknown>)[key] = currentValue;
      }
    }
    // Always persist workspaceFolder to survive migrations and plugin updates
    (dataToSave as Record<string, unknown>).workspaceFolder = this.settings.workspaceFolder;
    if (this.storageStatePath && this.storageStatePath !== storagePaths.state && this.wsManager) {
      if (await this.app.vault.adapter.exists(`${storagePaths.state}/gemini-workspace.json`)) throw new Error("storage-state-target-exists");
      await this.wsManager.persistWorkspaceState();
    }
    await this.saveData(dataToSave);
    this.storageStatePath = storagePaths.state;
    this.settingsEmitter.emit("settings-updated", this.settings);

    // Always reinitialize clients to pick up any config changes
    this.initializeClients();

    // Re-register workflow hotkeys
    this.registerWorkflowHotkeys();
  }

  registerWorkflowHotkeys(): void {
    this.workflowMgr.registerHotkeys();
  }

  async executeWorkflowFromHotkey(filePath: string): Promise<void> {
    return this.workflowMgr.executeFromHotkey(filePath);
  }

  registerWorkflowEventListeners(): void {
    this.workflowMgr.registerEventListeners();
  }

  // ========================================
  // Workspace State Methods (delegated to WorkspaceStateManager)
  // ========================================

  getWorkspaceStateFilePath(): string {
    return this.wsManager.getWorkspaceStateFilePath();
  }

  async loadWorkspaceState(): Promise<void> {
    await this.wsManager.loadWorkspaceState();
    this.settingsEmitter.emit("workspace-state-loaded", this.workspaceState);
  }

  async loadOrCreateWorkspaceState(): Promise<void> {
    return this.wsManager.loadOrCreateWorkspaceState();
  }

  async saveWorkspaceState(): Promise<void> {
    return this.wsManager.saveWorkspaceState();
  }

  /**
   * Show or hide the workspace folder in the file explorer.
   *
   * Toggles a body class; the actual `display: none` lives in styles.css and
   * targets the default folder name (`LLMHub`) via an attribute selector. A
   * pure-CSS rule on `document.body` survives file-explorer re-renders without
   * any DOM observer dance.
   *
   * Limitation: only hides the default workspace folder path. Custom paths
   * (`workspaceFolder` renamed away from `LLMHub`) are not covered — the
   * workspace folder UI can always be used to revert the rename.
   */
  updateWorkspaceFolderVisibility(): void {
    document.body.classList.toggle(
      "llm-hub-hide-workspace-folder",
      this.settings.hideWorkspaceFolder
    );
  }

  getSelectedRagSetting(): RagSetting | null {
    return this.wsManager.getSelectedRagSetting();
  }

  getRagSetting(name: string): RagSetting | null {
    return this.wsManager.getRagSetting(name);
  }

  getRagSearchSetting(name: string): RagSetting | null {
    return this.getRagSetting(name);
  }

  getRagSettingNames(): string[] {
    return this.wsManager.getRagSettingNames();
  }

  async selectRagSetting(name: string | null): Promise<void> {
    return this.wsManager.selectRagSetting(name);
  }

  async selectSearchSelection(selection: import("./types").SearchSelection): Promise<void> {
    return this.wsManager.selectSearchSelection(selection);
  }

  async selectModel(model: ModelType): Promise<void> {
    return this.wsManager.selectModel(model);
  }

  getSelectedModel(): ModelType {
    return this.wsManager.getSelectedModel();
  }

  async createRagSetting(name: string, setting?: Partial<RagSetting>): Promise<void> {
    return this.wsManager.createRagSetting(name, setting);
  }

  getRequestControls(): RequestControls { return validateRequestControls({ ...DEFAULT_REQUEST_CONTROLS, ...this.settings.requestControls }); }
  requestProtectionChoices?: RequestProtectionChoices;

  private knowledgeScope(purpose: 'query' | 'answer' | 'index' | 'rerank', endpoint: string, name: string, model = '') {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效的服务地址');
    const controls = this.getRequestControls();
    if (isLocalRequestOrigin(url.origin, controls)) return { local: true } as const;
    const scope = new Map<string, unknown>();
    const includeIndex = (index: string) => {
      if (scope.has(index)) return;
      const setting = this.getRagSetting(index);
      scope.set(index, setting && [setting.targetFolders, setting.excludePatterns, setting.externalIndexPath,
        setting.sourceManifestId, setting.searchFileExtensions, setting.indexMultimodal, setting.sourceRagSettings]);
      for (const child of setting?.sourceRagSettings ?? []) includeIndex(child);
    };
    includeIndex(name);
    return { local: false, blocked: controls.outbound === 'local-only', choice: {
      origin: url.origin, model: `${model} · ${name}`, reason: `knowledge-${purpose}`,
      settingsKey: JSON.stringify([this.settings.workspaceFolder, url.pathname, url.search, [...scope], controls.outbound, controls.redactionRules]),
    } } as const;
  }

  async confirmKnowledgeDestination(purpose: 'query' | 'answer' | 'index' | 'rerank', endpoint: string, name: string, model?: string): Promise<boolean> {
    const scope = this.knowledgeScope(purpose, endpoint, name, model);
    if (scope.local) return true;
    if (scope.blocked || !this.requestProtectionChoices) return false;
    return this.requestProtectionChoices.allow(scope.choice);
  }

  async ordinaryGroundedCondition(restriction: string, model: string, remember = false): Promise<boolean> {
    const scope = { origin: '', model, reason: 'knowledge-ordinary', settingsKey: JSON.stringify([this.settings.workspaceFolder, restriction]) };
    if (remember) await this.requestProtectionChoices?.rememberAllow(scope);
    return (await this.requestProtectionChoices?.remembered(scope)) === true;
  }

  private indexDestination(name: string) {
    const setting = this.getRagSetting(name);
    const connection = resolveEmbeddingConnection(setting, this.settings);
    if (!setting || connection.status !== 'ready') return;
    const model = setting.embeddingModel || (connection.kind === 'gemini' ? DEFAULT_GEMINI_EMBEDDING_MODEL : '');
    if (model) return this.knowledgeScope('index', connection.destination, name, model);
  }

  indexDestinationStatus(name: string): 'ready' | 'choose' | 'blocked' | 'unavailable' {
    const scope = this.indexDestination(name);
    if (!scope) return 'unavailable';
    if (scope.local) return 'ready';
    const choice = this.requestProtectionChoices?.known(scope.choice);
    return scope.blocked || choice === false ? 'blocked' : choice === true ? 'ready' : 'choose';
  }

  async chooseIndexDestination(name: string): Promise<void> {
    const scope = this.indexDestination(name);
    if (scope && !scope.local && !scope.blocked) await this.requestProtectionChoices?.allow(scope.choice);
    this.ragLifecycle?.refreshIdlePolicy();
  }

  async resetRequestProtectionChoices(): Promise<void> {
    await this.requestProtectionChoices?.reset();
    this.ragLifecycle?.refreshIdlePolicy();
  }

  private async refreshIndexDestinations(): Promise<void> {
    try {
      for (const [name, setting] of Object.entries(this.workspaceState.ragSettings)) {
        if (!setting.autoUpdateIndex || setting.externalIndexPath || setting.sourceRagSettings.length || setting.sourceCollection) continue;
        const scope = this.indexDestination(name);
        if (scope && !scope.local && !scope.blocked) await this.requestProtectionChoices?.remembered(scope.choice);
      }
    } finally {
      this.ragLifecycle?.refreshIdlePolicy();
    }
  }
  async updateRequestControls(updates: Partial<RequestControls>): Promise<void> {
    if(updates.openingBalanceCny!==undefined)updates={...updates,openingBalanceMonth:new Date().toISOString().slice(0,7)};
    const value=validateRequestControls({...this.getRequestControls(),...updates});
    this.settings.requestControls=value;await this.saveSettings();
  }

  async updateRagSetting(name: string, updates: Partial<RagSetting>): Promise<void> {
    await this.wsManager.updateRagSetting(name, updates);
    this.ragLifecycle?.refreshIdlePolicy();
    const setting = this.getRagSetting(name);
    if (updates.autoUpdateIndex === true && setting?.autoUpdateIndex && !setting.externalIndexPath && !setting.sourceRagSettings.length && !setting.sourceCollection)
      void this.ragLifecycle?.reconcile(name, undefined, true).catch(error => console.warn('自动索引校核失败', formatError(error)));
  }

  async deleteRagSetting(name: string): Promise<void> {
    for (const task of this.tasks.list()) if (task.snapshot.descriptor?.setting === name) task.cancel();
    await this.ragLifecycle?.forget(name);
    return this.wsManager.deleteRagSetting(name);
  }

  async renameRagSetting(oldName: string, newName: string): Promise<void> {
    for (const task of this.tasks.list()) if (task.snapshot.descriptor?.setting === oldName) task.cancel();
    await this.ragLifecycle?.cancel(oldName);
    await this.ragLifecycle?.flush();
    await this.wsManager.renameRagSetting(oldName, newName);
    await this.ragLifecycle?.renameSetting(oldName,newName);
    forgetRagDocumentStore(this.app.vault.adapter, this.settings.workspaceFolder, oldName);
    forgetRagDocumentStore(this.app.vault.adapter, this.settings.workspaceFolder, newName);
  }

  async resetRagSettingSyncState(name: string): Promise<void> {
    return this.wsManager.resetRagSettingSyncState(name);
  }

  getVaultStoreName(): string {
    return this.wsManager.getVaultStoreName();
  }

  // Migrate from old settings format (plugin-specific parts)
  private async migrateSlashCommands(): Promise<void> {
    // Add default infographic command if not present
    const hasInfographicCommand = this.settings.slashCommands.some(
      (cmd) => cmd.name === "infographic"
    );
    if (!hasInfographicCommand) {
      this.settings.slashCommands.push({
        id: "cmd_infographic_default",
        name: "infographic",
        promptTemplate: "Convert the following content into an HTML infographic. Output the HTML directly in your response, do not create a note:\n\n{selection}",
        model: null,
        description: "Generate HTML infographic from selection or active note",
        searchSelection: null,
      });
      await this.saveSettings();
    }
  }

  private initializeClients() {
    // Only initialize Gemini API client when a Gemini provider is configured
    const geminiApiKey = getGeminiApiKey(this.settings);
    if (geminiApiKey) {
      // Use first available model from Gemini provider, or a reasonable default
      const geminiProvider = this.settings.apiProviders.find(p => p.type === "gemini" && p.enabled);
      const defaultModel = geminiProvider?.enabledModels[0] || "gemini-3.8-flash";
      initGeminiClient(geminiApiKey, defaultModel as ModelType, this.settings.proxyUrl, this.settings.proxyBypass, geminiProvider?.baseUrl);
    }
    initLangfuse(this.settings.langfuse);

    // Initialize CLI provider manager
    initCliProviderManager();

    // Initialize edit history manager
    const editHistorySettings = this.settings.editHistory || DEFAULT_EDIT_HISTORY_SETTINGS;
    initEditHistoryManager(this.app, editHistorySettings);

    // Initialize local RAG store and preload existing index
    const localRag = initLocalRagStore();
    localRag.workspaceFolder = this.settings.workspaceFolder || DEFAULT_WORKSPACE_FOLDER;
    void localRag.load(
      this.app,
      Object.keys(this.workspaceState.ragSettings),
      this.workspaceState.ragSettings
    );


  }

  private async ensureChatViewExists() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT);
    if (leaves.length === 0) {
      let leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        leaf = this.app.workspace.getRightLeaf(true);
      }
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_GEMINI_CHAT,
          active: false,
        });
      }
    }
  }

  async activateCliTerminalView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;

    const existingLeaves = workspace.getLeavesOfType(CLI_TERMINAL_VIEW_TYPE);
    if (existingLeaves.length > 0) {
      leaf = existingLeaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        leaf = workspace.getRightLeaf(true);
      }
      if (leaf) {
        await leaf.setViewState({
          type: CLI_TERMINAL_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      void workspace.revealLeaf(leaf);
    }
  }

  /** Delegate dashboard creation to the standalone Dashboard Hub plugin. */
  async createDashboard(requestedName = "Dashboard"): Promise<TFile | null> {
    const app = this.app as typeof this.app & {
      plugins?: { plugins?: Record<string, unknown> };
    };
    const dashboardHub = app.plugins?.plugins?.["dashboard-hub"] as DashboardHubApi | undefined;
    if (!dashboardHub?.createDashboard) {
      new Notice("Install and enable Dashboard Hub to create dashboards.");
      return null;
    }
    return dashboardHub.createDashboard(requestedName);
  }

  private notifyDashboardHubMigration(): void {
    this.app.workspace.onLayoutReady(() => {
      const app = this.app as typeof this.app & {
        plugins?: {
          plugins?: Record<string, unknown>;
          enabledPlugins?: { has: (id: string) => boolean };
        };
      };
      if (app.plugins?.plugins?.["dashboard-hub"] || app.plugins?.enabledPlugins?.has("dashboard-hub")) return;
      if (!app.vault.getFiles().some((file) => file.extension === "dashboard")) return;
      if (this.settings.dashboardHubMigrationNoticeShown) return;

      this.settings.dashboardHubMigrationNoticeShown = true;
      void this.saveSettings().catch((error) => {
        console.error("LLM Hub: Failed to persist Dashboard Hub migration notice:", formatError(error));
      });
      new Notice("Existing .dashboard files now require the separate Dashboard Hub plugin. Install and enable Dashboard Hub to open them.", 15000);
    });
  }

  private registerDashboardHubIntegration(): void {
    const integration: DashboardHubIntegration = {
      protocolVersion: 1,
      id: this.manifest.id,
      name: this.manifest.name,
      listModels: () => Promise.resolve(listDashboardModels(this)),
      getDefaultModel: () => Promise.resolve(this.getSelectedModel()),
      openChatWithDraft: (draft) => this.openChatWithDraft(draft),
      askChatAboutSelection: (request) => this.askChatAboutSelection(request),
      runWorkflow: (request) => runDashboardWorkflow(this, request),
      generateBase: (request) => generateDashboardBase(this, request),
      rewriteText: (request) => rewriteDashboardText(this, request),
      generateWorkflow: (request) => generateDashboardWorkflow(this, request),
    };
    const workspace = this.app.workspace as unknown as DashboardWorkspaceEvents;
    this.registerEvent(workspace.on("dashboard-hub:ready", (hub) => {
      hub.registerIntegration(integration);
    }));
    workspace.trigger("dashboard-hub:register-integration", integration);
    this.register(() => {
      workspace.trigger("dashboard-hub:unregister-integration", { id: integration.id, integration });
    });
  }

  private registerRuntimeSkillContributions(): void {
    const workspace = this.app.workspace as unknown as {
      on: (name: string, callback: (value: unknown) => void) => EventRef;
      trigger: (name: string) => void;
    };
    this.registerEvent(workspace.on(REGISTER_RUNTIME_SKILL_EVENT, (value) => {
      if (registerRuntimeSkill(value)) this.settingsEmitter.emit("skills-changed");
    }));
    this.registerEvent(workspace.on(UNREGISTER_RUNTIME_SKILL_EVENT, (value) => {
      if (unregisterRuntimeSkill(value)) this.settingsEmitter.emit("skills-changed");
    }));
    workspace.trigger(REQUEST_RUNTIME_SKILLS_EVENT);
  }

  async activateChatView(): Promise<void> {
    // Capture selection before switching focus
    this.captureSelection();

    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;

    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT);
    if (existingLeaves.length > 0) {
      leaf = existingLeaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_GEMINI_CHAT,
          active: true,
        });
      }
    }

    if (leaf) {
      void workspace.revealLeaf(leaf);
    }
  }

  async openDiscussionHub(request: { theme?: string; attachments?: import("src/types").Attachment[] } = {}): Promise<void> {
    const hub = this.getDiscussionHubApi();
    if (!hub?.openDiscussion) {
      new Notice("Install and enable Discussion Hub to use AI Discussion.");
      return;
    }
    await hub.openDiscussion(request);
  }

  getDiscussionHubApi(): DiscussionHubApi | null {
    const app = this.app as typeof this.app & { plugins?: { plugins?: Record<string, unknown> } };
    return (app.plugins?.plugins?.["discussion-hub"] as DiscussionHubApi | undefined) ?? null;
  }

  async askChatAboutSelection(selection: { text: string; sourcePath?: string }): Promise<void> {
    const text = selection.text.trim();
    if (!text) return;

    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_GEMINI_CHAT,
          active: true,
        });
      }
    }
    if (!leaf) return;

    await workspace.revealLeaf(leaf);
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      const view = leaf.view instanceof ChatView ? leaf.view : null;
      if (view) {
        view.askSelection({ text, sourcePath: selection.sourcePath });
        this.settingsEmitter.emit("chat-activated");
        return;
      }
    }
  }

  private async openReadingAction(context: ReadingContext, action: ReadingAction): Promise<void> {
    const sequence = this.readingActionSequence = (this.readingActionSequence ?? 0) + 1;
    try { context = await prepareSourceReading(this.app, context, action); }
    catch (error) { new Notice(sourceErrorText(error)); return; }
    if (sequence !== this.readingActionSequence) return;
    const questions = { explain: "reading.explainQuestion", example: "reading.exampleQuestion", compare: "reading.compareQuestion", quiz: "reading.quizQuestion" } as const;
    if (action in questions) context = { ...context, question: t(questions[action as keyof typeof questions]) };
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE_GEMINI_CHAT, active: true });
    }
    if (!leaf) { new Notice(t("reading.chatUnavailable")); return; }
    if (sequence !== this.readingActionSequence) return;
    await workspace.revealLeaf(leaf);
    for (let i = 0; i < 10; i++) {
      if (sequence !== this.readingActionSequence) return;
      const view = leaf.view instanceof ChatView ? leaf.view : null;
      if (view) {
        if (action === "search") view.searchReading(context);
        else view.askReading(context, action === "knowledge");
        this.settingsEmitter.emit("chat-activated");
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 30));
    }
    new Notice(t("reading.chatUnavailable"));
  }

  async openChatWithDraft(content: string): Promise<void> {
    const draft = content.trim();
    if (!draft) return;

    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_GEMINI_CHAT,
          active: true,
        });
      }
    }
    if (!leaf) return;

    await workspace.revealLeaf(leaf);
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      const view = leaf.view instanceof ChatView ? leaf.view : null;
      if (view) {
        view.setChatDraft(draft);
        this.settingsEmitter.emit("chat-activated");
        return;
      }
    }
  }

  // Toggle between chat view and last active markdown view
  private toggleChatView(): void {
    const chatLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT);
    const activeChatView = this.app.workspace.getActiveViewOfType(ChatView);

    if (activeChatView) {
      // Currently in chat, go back to last markdown view
      if (this.lastActiveMarkdownView?.leaf) {
        this.clearSelectionHighlight();
        this.app.workspace.setActiveLeaf(this.lastActiveMarkdownView.leaf, { focus: true });
      }
    } else {
      // Not in chat, capture selection and open/activate chat
      this.captureSelectionFromView(this.lastActiveMarkdownView);
      if (chatLeaves.length > 0) {
        this.app.workspace.setActiveLeaf(chatLeaves[0], { focus: true });
        // Notify Chat component that it's now active
        this.settingsEmitter.emit("chat-activated");
      } else {
        void this.activateChatView();
      }
    }
  }

  // Capture selection from a specific markdown view
  private captureSelectionFromView(view: MarkdownView | null): void {
    this.selectionManager.captureSelectionFromView(view);
  }

  captureSelection(): void {
    this.selectionManager.captureSelection();
  }

  clearSelectionHighlight(): void {
    this.selectionManager.clearSelectionHighlight();
  }

  getLastSelection(): string {
    return this.selectionManager.getLastSelection();
  }

  getSelectionLocation(): SelectionLocationInfo | null {
    return this.selectionManager.getSelectionLocation();
  }

  clearLastSelection(): void {
    this.selectionManager.clearLastSelection();
  }

  // Sync vault for local RAG (embedding-based)
  async syncVaultForLocalRAG(
    ragSettingName: string,
    onProgress?: (current: number, total: number, fileName: string, action: "embed" | "skip" | "remove") => void,
    signal?: AbortSignal,
    source = '',
  ): Promise<{ embedded: number; skipped: number; removed: number; errors: string[]; failedFiles?: string[] } | null> {
    return this.tasks.run(`RAG索引 · ${ragSettingName}`, task => this.performRagSync(ragSettingName, onProgress, task), {serial: true, signal, source,descriptor:{kind:"rag",setting:ragSettingName,source}});
  }
  private async performRagSync(
    ragSettingName: string,
    onProgress: ((current: number, total: number, fileName: string, action: "embed" | "skip" | "remove") => void) | undefined,
    control: WorkControl,
    convertedPaths?: string[],
  ): Promise<{ embedded: number; skipped: number; removed: number; errors: string[]; failedFiles?: string[] } | null> {
    const localRag = getLocalRagStore();
    const ragSetting = this.workspaceState.ragSettings[ragSettingName];
    const connection = resolveEmbeddingConnection(ragSetting, this.settings);
    const embeddingApiKey = connection.apiKey;
    assertRagSyncReady({ storeReady: Boolean(localRag), setting: ragSetting, embeddingKey: embeddingApiKey });
    // The assertion above reports the user-facing reason; this also narrows the types.
    if (!localRag || !ragSetting) throw new Error("RAG sync prerequisites unavailable");
    if (connection.status !== 'ready') throw new Error('请检查嵌入服务地址和凭据');
    if (this.ragLifecycle && !ragSetting.sourceCollection && !ragSetting.externalIndexPath && !ragSetting.sourceRagSettings.length
      && (ragSetting.autoUpdateIndex !== undefined || await getRagDocumentStore(this.app.vault.adapter, this.settings.workspaceFolder, ragSettingName).isActive())) {
      const cancel = () => { void this.ragLifecycle?.cancel(ragSettingName); };
      control.signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await this.ragLifecycle.reconcile(ragSettingName, control);
        const status = await localRag.getStatus(this.app, ragSettingName);
        onProgress?.(status.fileCount, status.fileCount, '', 'embed');
        return result;
      } finally { control.signal.removeEventListener('abort', cancel); }
    }
    if (ragSetting.sourceCollection && !convertedPaths) {
      if (!this.sourceIngest) throw new SourceDocumentError("index-conflict");
      convertedPaths = await this.sourceIngest.getIndexPaths(ragSettingName);
    }
    if (convertedPaths && !ragSetting.sourceCollection) throw new SourceDocumentError("index-conflict");

    try {
      const effectiveModel = ragSetting.embeddingModel || (ragSetting.embeddingBaseUrl ? "" : DEFAULT_GEMINI_EMBEDDING_MODEL);
      if (!ragSetting.sourceCollection && !await this.confirmKnowledgeDestination('index', connection.destination, ragSettingName, effectiveModel)) {
        throw new Error('当前设置暂停了远程索引更新');
      }
      // Auto-enable multimodal indexing:
      // - Gemini native embedding models: full multimodal (PDF binary, images, audio, video)
      // - Non-Gemini (custom base URL): PDF only via text extraction
      const indexMultimodal = !ragSetting.embeddingBaseUrl
        ? isGeminiMultimodalEmbeddingModel(effectiveModel)
        : true;
      const failedFiles = new Set<string>();
      let result = await localRag.sync(
        this.app,
        ragSettingName,
        embeddingApiKey,
        effectiveModel,
        ragSetting.chunkSize,
        ragSetting.chunkOverlap,
        ragSetting.pdfChunkPages ?? 6,
        {
          includeFolders: ragSetting.targetFolders,
          excludePatterns: ragSetting.excludePatterns,
          ...(convertedPaths ? { includeFolders: [], excludePatterns: [], filePaths: convertedPaths } : {}),
        },
        onProgress,
        ragSetting.embeddingBaseUrl || undefined,
        indexMultimodal,
        this.settings.proxyUrl,
        this.settings.proxyBypass,
        control,
      );
      result.failedFiles?.forEach(filePath => failedFiles.add(filePath));
      const totals = {embedded: result.embedded, removed: result.removed, errors: [...result.errors]};
      while (hasMoreRagWork(result)) {
        await control.checkpoint();
        result = await localRag.sync(
          this.app,
          ragSettingName,
          embeddingApiKey,
          effectiveModel,
          ragSetting.chunkSize,
          ragSetting.chunkOverlap,
          ragSetting.pdfChunkPages ?? 6,
          {
            includeFolders: ragSetting.targetFolders,
            excludePatterns: ragSetting.excludePatterns,
            ...(convertedPaths ? { includeFolders: [], excludePatterns: [], filePaths: convertedPaths } : {}),
          },
          onProgress,
          ragSetting.embeddingBaseUrl || undefined,
          indexMultimodal,
          this.settings.proxyUrl,
          this.settings.proxyBypass,
          control,
        );
        totals.embedded += result.embedded; totals.removed += result.removed; totals.errors.push(...result.errors);
        result.failedFiles?.forEach(filePath => failedFiles.add(filePath));
      }

      if(totals.errors.length||failedFiles.size)throw new Error(`RAG部分处理失败；已保存结果保留。${[...totals.errors,...failedFiles].slice(0,3).join('；')}`);
      await control.checkpoint();
      // Update sync metadata
      this.workspaceState.ragSettings[ragSettingName] = {
        ...ragSetting,
        lastFullSync: totals.errors.length === 0 ? Date.now() : ragSetting.lastFullSync,
      };
      await this.saveWorkspaceState();
      this.settingsEmitter.emit("workspace-state-loaded", this.workspaceState);

      return { ...result, ...totals, failedFiles: Array.from(failedFiles) };
    } catch (error) {
      throw (error instanceof Error ? error : new Error(formatError(error)));
    }
  }

  async rebuildRagIndex(name: string): Promise<void> {
    if (!this.ragLifecycle) throw new Error('索引服务尚未就绪');
    await this.tasks.run(`强制重建索引 · ${name}`, control => this.ragLifecycle!.rebuild(name, control), { descriptor: { kind: 'custom', setting: name } });
    getLocalRagStore()?.clearAll();
  }

  async compactRagIndex(name: string): Promise<void> {
    const setting = this.getRagSetting(name);
    if (!setting || setting.externalIndexPath || setting.sourceRagSettings.length || setting.sourceCollection) throw new Error(t('index.noTarget'));
    await this.tasks.run(t('index.compact'), control => getRagDocumentStore(this.app.vault.adapter, this.settings.workspaceFolder, name).compact(control), { descriptor: { kind: 'custom', setting: name } });
  }

  async updateNoteIndex(path: string, name: string, force = false): Promise<void> {
    if (!this.ragLifecycle) throw new Error('索引服务尚未就绪');
    const result = await this.ragLifecycle.updateNow(name, path, force);
    new Notice(result === 'current' ? t('index.current') : t('index.updated'));
  }

  private chooseNoteIndex(path: string, force: boolean): void {
    try {
      const targets = this.ragLifecycle?.targets(path) ?? [];
      const update = (name: string) => { void this.updateNoteIndex(path, name, force).catch(error => new Notice(formatError(error))); };
      if (!targets.length) new Notice(t('index.noTarget'));
      else if (targets.length === 1) update(targets[0]);
      else new RagIndexTargetModal(this.app, targets, update).open();
    } catch (error) { new Notice(formatError(error)); }
  }

  // Clear local RAG index
  async clearLocalRagIndex(ragSettingName: string): Promise<void> {
    const ragSetting = this.workspaceState.ragSettings[ragSettingName];
    if (ragSetting?.externalIndexPath || ragSetting?.sourceRagSettings.length) {
      new Notice(t("settings.externalIndexSyncDisabled"));
      return;
    }

    for (const task of this.tasks.list()) if (task.snapshot.descriptor?.setting === ragSettingName) task.cancel();
    await this.ragLifecycle?.forget(ragSettingName);
    const localRag = getLocalRagStore();
    if (localRag) {
      await localRag.clear(this.app, ragSettingName);
    }

    if (ragSetting) {
      this.workspaceState.ragSettings[ragSettingName] = {
        ...ragSetting,
        lastFullSync: null,
      };
      await this.saveWorkspaceState();
      this.settingsEmitter.emit("workspace-state-loaded", this.workspaceState);
    }
  }

  // Get slash commands for workflow
  getSlashCommands(): SlashCommand[] {
    return this.settings.slashCommands;
  }

  // Execute a slash command for workflow
  async executeSlashCommand(
    commandIdOrName: string,
    options?: {
      value?: string;
      contentPath?: string;
      selection?: { path: string; start: unknown; end: unknown };
      chatId?: string;
    }
  ): Promise<{ response: string; chatId: string }> {
    // Find the command
    const command = this.settings.slashCommands.find(
      (cmd) => cmd.id === commandIdOrName || cmd.name === commandIdOrName
    );

    if (!command) {
      throw new Error(`Slash command not found: ${commandIdOrName}`);
    }

    // Get the content to use
    let content = "";
    if (options?.value) {
      content = options.value;
    } else if (options?.contentPath) {
      // Read content from file
      const file = this.app.vault.getAbstractFileByPath(options.contentPath);
      if (file instanceof TFile) {
        content = await this.app.vault.read(file);
      }
    } else if (options?.selection) {
      // Read content from selection
      const selectionPath = options.selection.path;
      const file = this.app.vault.getAbstractFileByPath(selectionPath);
      if (file instanceof TFile) {
        const fileContent = await this.app.vault.read(file);
        // For now, just use the whole file content
        // TODO: Extract selection range
        content = fileContent;
      }
    }

    // Replace {selection} placeholder in template
    const prompt = command.promptTemplate.replace(/\{selection\}/g, content);

    // Get the Gemini client
    const client = getGeminiClient();
    if (!client) {
      throw new Error("Gemini client not initialized");
    }

    // Set model if specified
    if (command.model) {
      client.setModel(command.model);
    }

    // Send message
    const response = await client.chat(
      [{ role: "user", content: prompt, timestamp: Date.now() }],
      this.settings.systemPrompt || undefined
    );

    // Generate or use existing chatId
    const chatId = options?.chatId || `workflow-${Date.now()}`;

    return { response, chatId };
  }

  // ========================================
  // Encryption Methods
  // ========================================

  /**
   * Encrypt a file
   */
  async encryptFile(file: TFile): Promise<void> {
    return this.encryptionManager.encryptFile(file);
  }

  private async checkAndOpenEncryptedFile(file: TFile): Promise<void> {
    return this.encryptionManager.checkAndOpenEncryptedFile(file);
  }

  async decryptCurrentFile(file: TFile): Promise<void> {
    return this.encryptionManager.decryptCurrentFile(file);
  }
}
