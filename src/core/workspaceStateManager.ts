import { App, Notice, Platform } from "obsidian";
import { getStoragePaths, ensureStorageDirectory } from "./storagePaths";
import type { EventEmitter } from "../utils/EventEmitter";
import {
  type LlmHubSettings,
  type WorkspaceState,
  type RagSetting,
  type ModelType,
  type SearchSelection,
  DEFAULT_WORKSPACE_STATE,
  DEFAULT_RAG_SETTING,
  DEFAULT_WORKSPACE_FOLDER,
  getDefaultModel,
  isApiProviderModel,
  getApiProviderId,
  isLocalLlmModel,
  getLocalLlmId,
  getLocalLlmModelName,
  getLocalLlmEnabledModels,
  normalizeDeprecatedModelIdentifier,
} from "../types";
import {
  assertNoRagSettingCollision,
  deleteRagSettingFromState,
  formatError,
  pruneRagSettingSources,
  renameRagSettingInState,
  sanitizeRagSettingName,
} from "obsidian-llm-hub-common/core";
import { deleteRagIndex, renameRagIndex, getRagDirectory } from "./localRagStorage";
import { SourceDocumentError } from "./sourceDocuments";
import { t } from "../i18n";
import { getLocalRagStore } from "./localRagStore";
import { searchSelectionFromWorkspace } from "./webSearch";
import {
  applyRagCredentials,
  clearRagCredentialMarkers,
  collectRagCredentials,
  ragCredentialSecretId,
  stripWorkspaceCredentials,
  type RagCredentialBundle,
} from "./credentialBundle";
import { isSecretStorageAvailable, readSecretJson, writeSecretJson } from "./secretStorage";

const WORKSPACE_STATE_FILENAME = "gemini-workspace.json";
const OLD_WORKSPACE_STATE_FILENAME = ".gemini-workspace.json";

export class WorkspaceStateManager {
  configurationSaver?: (value: WorkspaceState) => Promise<void>;
  workspaceState: WorkspaceState = { ...DEFAULT_WORKSPACE_STATE, ragSettings: {} };

  constructor(
    private app: App,
    private getSettings: () => LlmHubSettings,
    private settingsEmitter: EventEmitter,
    private loadDataCallback: () => Promise<unknown>
  ) {}

  private get settings(): LlmHubSettings {
    return this.getSettings();
  }

  private get stateFolder(): string {
    return getStoragePaths(this.settings, this.app.vault.configDir).state || DEFAULT_WORKSPACE_FOLDER;
  }

  private get workspaceFolder(): string { return getStoragePaths(this.settings, this.app.vault.configDir).workspace; }

  // Get the path to the workspace state file
  getWorkspaceStateFilePath(): string {
    return `${this.stateFolder}/${WORKSPACE_STATE_FILENAME}`;
  }

  // Get old workspace state file path (for migration)
  private getOldWorkspaceStateFilePath(): string {
    return `${this.stateFolder}/${OLD_WORKSPACE_STATE_FILENAME}`;
  }

  // Load workspace state from file
  async loadWorkspaceState(): Promise<void> {
    this.workspaceState = { ...DEFAULT_WORKSPACE_STATE, ragSettings: {} };

    const filePath = this.getWorkspaceStateFilePath();

    try {
      let exists = await this.app.vault.adapter.exists(filePath);

      // Migrate from old hidden file name if new file doesn't exist
      if (!exists) {
        const oldFilePath = this.getOldWorkspaceStateFilePath();
        const oldExists = await this.app.vault.adapter.exists(oldFilePath);
        if (oldExists) {
          const content = await this.app.vault.adapter.read(oldFilePath);
          await this.app.vault.adapter.write(filePath, content);
          await this.app.vault.adapter.remove(oldFilePath);
          exists = true;
        }
      }

      if (exists) {
        await this.loadWorkspaceStateFromPath(filePath);
      }
    } catch (error) {
      // Log error for debugging
      console.error("LLM Hub: Failed to load workspace state:", formatError(error));
    }
  }

  private async loadWorkspaceStateFromPath(filePath: string): Promise<void> {
    const content = await this.app.vault.adapter.read(filePath);
    const loaded = JSON.parse(content) as Partial<WorkspaceState>;
    this.workspaceState = { ...DEFAULT_WORKSPACE_STATE, ragSettings: {}, ...loaded };
    const legacyWebSearch = this.workspaceState.selectedRagSetting === "__websearch__";
    const selection = searchSelectionFromWorkspace(
      this.workspaceState.selectedRagSetting,
      loaded.webSearchEnabled,
    );
    this.workspaceState.selectedRagSetting = selection.ragSetting;
    this.workspaceState.webSearchEnabled = selection.webSearch;
    if (this.workspaceState.selectedModel) {
      this.workspaceState.selectedModel = normalizeDeprecatedModelIdentifier(this.workspaceState.selectedModel) as ModelType;
    }

    // Ensure each RAG setting has all required fields (migration for new fields)
    for (const [settingName, setting] of Object.entries(this.workspaceState.ragSettings)) {
      this.workspaceState.ragSettings[settingName] = {
        ...DEFAULT_RAG_SETTING,
        ...setting,
      };
    }

    // Restore embedding keys that were moved into SecretStorage. Runs in both
    // storage modes so a device holding the secrets can still recover them.
    const stored = readSecretJson<RagCredentialBundle>(this.app, ragCredentialSecretId(this.workspaceFolder));
    if (stored) applyRagCredentials(this.workspaceState, stored);

    if (legacyWebSearch) {
      await this.app.vault.adapter.write(filePath, JSON.stringify(this.persistableWorkspaceState(), null, 2));
    }
  }

  // Load workspace state, create file if not exists
  async loadOrCreateWorkspaceState(): Promise<void> {
    await this.loadWorkspaceState();

    const filePath = this.getWorkspaceStateFilePath();
    const exists = await this.app.vault.adapter.exists(filePath);
    if (!exists) {
      await this.saveWorkspaceState();
    }
  }

  /**
   * The state as it should be written to the vault. In secretStorage mode the
   * embedding API keys are moved into a per-workspace secret first; if that
   * write fails the keys stay in the file rather than being lost.
   */
  private persistableWorkspaceState(): WorkspaceState {
    if (this.settings.credentialStorage !== "secretStorage" || !isSecretStorageAvailable(this.app)) {
      return clearRagCredentialMarkers(this.workspaceState);
    }
    const stored = writeSecretJson(
      this.app,
      ragCredentialSecretId(this.workspaceFolder),
      collectRagCredentials(this.workspaceState),
    );
    return stored ? stripWorkspaceCredentials(this.workspaceState) : this.workspaceState;
  }

  // Save workspace state to file
  async saveWorkspaceState(): Promise<void> {
    if (this.configurationSaver) return this.configurationSaver(this.workspaceState);
    return this.persistWorkspaceState();
  }

  async persistWorkspaceState(): Promise<void> {
    const filePath = this.getWorkspaceStateFilePath();
    const content = JSON.stringify(this.persistableWorkspaceState(), null, 2);

    // Ensure folder exists
    const wsFolder = this.stateFolder;
    const folderExists = await this.app.vault.adapter.exists(wsFolder);
    if (!folderExists) {
      await ensureStorageDirectory(this.app.vault.adapter, wsFolder);
    }

    await this.app.vault.adapter.write(filePath, content);
  }

  // Get currently selected RAG setting
  getSelectedRagSetting(): RagSetting | null {
    const name = this.workspaceState.selectedRagSetting;
    if (!name) return null;
    return this.workspaceState.ragSettings[name] || null;
  }

  // Get RAG setting by name
  getRagSetting(name: string): RagSetting | null {
    return this.workspaceState.ragSettings[name] || null;
  }

  // Get all RAG setting names
  getRagSettingNames(): string[] {
    return Object.keys(this.workspaceState.ragSettings);
  }

  // Select a RAG setting
  async selectRagSetting(name: string | null): Promise<void> {
    this.workspaceState.selectedRagSetting = name;
    await this.saveWorkspaceState();
    this.settingsEmitter.emit("rag-setting-changed", name);
  }

  async selectSearchSelection(selection: SearchSelection): Promise<void> {
    this.workspaceState.selectedRagSetting = selection.ragSetting;
    this.workspaceState.webSearchEnabled = selection.webSearch;
    await this.saveWorkspaceState();
    this.settingsEmitter.emit("search-selection-changed", { ...selection });
  }

  // Select a model
  async selectModel(model: ModelType): Promise<void> {
    this.workspaceState.selectedModel = model;
    await this.saveWorkspaceState();
  }

  // Get selected model
  getSelectedModel(): ModelType {
    const fallback = getDefaultModel(this.settings);
    const selected = this.workspaceState.selectedModel || fallback;

    // CLI models are only allowed on desktop if verified
    const cliConfig = this.settings.cliConfig;
    if (selected === "antigravity-cli") {
      if (Platform.isMobile || !cliConfig?.cliVerified) return fallback;
      return selected;
    }
    if (selected === "claude-cli") {
      if (Platform.isMobile || !cliConfig?.claudeCliVerified) return fallback;
      return selected;
    }
    if (selected === "codex-cli") {
      if (Platform.isMobile || !cliConfig?.codexCliVerified) return fallback;
      return selected;
    }
    if (isLocalLlmModel(selected)) {
      if (Platform.isMobile) return fallback;
      const configs = this.settings.localLlmConfigs ?? [];
      const id = getLocalLlmId(selected);
      if (id) {
        const match = configs.find(c => c.id === id && c.verified && c.enabled !== false);
        if (!match) return fallback;
        const enabled = getLocalLlmEnabledModels(match);
        const requested = getLocalLlmModelName(selected);
        if (requested) {
          // Stored selection still names a model the user enabled — keep it.
          if (enabled.includes(requested)) return selected;
          // Stale: model was disabled or removed. Fall back to the config's
          // first enabled model so the user lands on a runnable selection.
          if (enabled.length > 0) {
            return `local-llm:${match.id}:${enabled[0]}` as ModelType;
          }
          return fallback;
        }
        // Legacy `local-llm:{id}` (no model suffix) — pin it to a concrete
        // model so the new dropdown can find a matching <option>.
        if (enabled.length > 0) {
          return `local-llm:${match.id}:${enabled[0]}` as ModelType;
        }
        return fallback;
      }
      // Legacy bare "local-llm" — upgrade to the first verified entry's
      // first enabled model so the dropdown selection is well-formed.
      const first = configs.find(c => c.verified && c.enabled !== false);
      if (!first) return fallback;
      const enabled = getLocalLlmEnabledModels(first);
      if (enabled.length === 0) return fallback;
      return `local-llm:${first.id}:${enabled[0]}` as ModelType;
    }

    // Validate api:* models against provider list
    if (isApiProviderModel(selected)) {
      const providerId = getApiProviderId(selected);
      const provider = this.settings.apiProviders.find(p => p.id === providerId && p.enabled && p.verified);
      return provider ? selected : fallback;
    }

    return fallback;
  }

  // Create a new RAG setting
  private assertAvailableRagName(name: string, exclude?: string): void {
    assertNoRagSettingCollision(this.workspaceState, name, exclude);
    const directory = sanitizeRagSettingName(name).toLowerCase();
    // Windows vaults are normally case-insensitive; keep names portable as well.
    if (Object.keys(this.workspaceState.ragSettings).some(existing => existing !== exclude && sanitizeRagSettingName(existing).toLowerCase() === directory)) {
      throw new Error(`RAG setting "${name}" conflicts with an existing index directory`);
    }
  }

  async ensureSourceRagSetting(name: string, collectionId: string, manifestExists: boolean): Promise<void> {
    if (!name.trim() || name !== name.trim() || /[\\/]/.test(name) || [".", ".."].includes(name) || !collectionId) throw new SourceDocumentError("index-conflict");
    try { this.assertAvailableRagName(name, name); } catch { throw new SourceDocumentError("index-conflict"); }
    const existing = this.workspaceState.ragSettings[name];
    if (existing) {
      if (!manifestExists || !existing.sourceCollection || existing.sourceManifestId !== collectionId || existing.externalIndexPath || existing.sourceRagSettings.length) throw new SourceDocumentError("index-conflict");
      return;
    }
    const directory = `${getRagDirectory(this.workspaceFolder)}/${sanitizeRagSettingName(name)}`;
    if (await this.app.vault.adapter.exists(directory)) throw new SourceDocumentError("index-conflict");
    const template = this.workspaceState.selectedRagSetting ? this.getRagSetting(this.workspaceState.selectedRagSetting) : null;
    await this.createRagSetting(name, { sourceCollection: true, sourceManifestId: collectionId, searchFileExtensions: ["md"],
      ...(template ? { embeddingApiKey: template.embeddingApiKey, embeddingBaseUrl: template.embeddingBaseUrl, embeddingModel: template.embeddingModel } : {}) });
  }

  async createRagSetting(name: string, setting?: Partial<RagSetting>): Promise<void> {
    if (this.workspaceState.ragSettings[name]) {
      throw new Error(`Semantic search setting "${name}" already exists`);
    }
    this.assertAvailableRagName(name);

    this.workspaceState.ragSettings[name] = {
      ...DEFAULT_RAG_SETTING,
      autoUpdateIndex: !setting?.sourceCollection && !setting?.externalIndexPath && !setting?.sourceRagSettings?.length,
      ...setting,
    };

    await this.saveWorkspaceState();
    this.settingsEmitter.emit("workspace-state-loaded", this.workspaceState);
  }

  // Update a RAG setting
  async updateRagSetting(name: string, updates: Partial<RagSetting>): Promise<void> {
    const existing = this.workspaceState.ragSettings[name];
    if (!existing) {
      throw new Error(`Semantic search setting "${name}" not found`);
    }

    if (existing.sourceCollection && ((updates.sourceCollection !== undefined && !updates.sourceCollection)
      || (updates.sourceManifestId !== undefined && updates.sourceManifestId !== existing.sourceManifestId)
      || updates.externalIndexPath?.trim() || updates.sourceRagSettings?.length)) {
      throw new Error(t("settings.sourceCollectionLocked"));
    }

    this.workspaceState.ragSettings[name] = pruneRagSettingSources(
      this.workspaceState,
      name,
      { ...existing, ...updates, ...(updates.embeddingApiKey === '' ? { embeddingApiKeyConfigured: false } : {}) },
    );

    await this.saveWorkspaceState();
  }

  // Delete a RAG setting
  async deleteRagSetting(name: string): Promise<void> {
    if (!this.workspaceState.ragSettings[name]) {
      return;
    }

    deleteRagSettingFromState(this.workspaceState, name);
    // The index is stored under the setting's name, so it goes with it rather
    // than sitting in the vault forever with nothing pointing at it.
    await deleteRagIndex(this.app, name, this.workspaceFolder);
    getLocalRagStore()?.clearAll();

    await this.saveWorkspaceState();
    this.settingsEmitter.emit("workspace-state-loaded", this.workspaceState);
  }

  // Rename a RAG setting
  async renameRagSetting(oldName: string, newName: string): Promise<void> {
    if (!this.workspaceState.ragSettings[oldName]) {
      throw new Error(`Semantic search setting "${oldName}" not found`);
    }
    if (this.workspaceState.ragSettings[oldName].sourceCollection) throw new Error(t("settings.sourceCollectionLocked"));
    if (this.workspaceState.ragSettings[newName]) {
      throw new Error(`Semantic search setting "${newName}" already exists`);
    }
    this.assertAvailableRagName(newName, oldName);

    // The index directory is named after the setting, so it moves with it;
    // otherwise the renamed setting starts from nothing and re-embeds the vault.
    await renameRagIndex(this.app, oldName, newName, this.workspaceFolder);
    getLocalRagStore()?.clearAll();

    const previousState=structuredClone(this.workspaceState);
    try{renameRagSettingInState(this.workspaceState, oldName, newName);await this.saveWorkspaceState();}
    catch(error){this.workspaceState=previousState;await renameRagIndex(this.app,newName,oldName,this.workspaceFolder);throw error;}
    this.settingsEmitter.emit("workspace-state-loaded", this.workspaceState);
  }

  // Reset sync state for a RAG setting
  async resetRagSettingSyncState(name: string): Promise<void> {
    const setting = this.workspaceState.ragSettings[name];
    if (!setting) {
      throw new Error(`Semantic search setting "${name}" not found`);
    }

    this.workspaceState.ragSettings[name] = {
      ...setting,
      lastFullSync: null,
    };

    await this.saveWorkspaceState();
    new Notice("Sync state has been reset. Next sync will re-embed all files.");
  }

  // Get vault name for store naming
  getVaultStoreName(): string {
    const vaultName = this.app.vault.getName();
    return `obsidian-${vaultName}`;
  }

  // Migrate from old settings format
  async migrateFromOldSettings(): Promise<void> {
    const data = await this.loadDataCallback() as Record<string, unknown> | undefined;
    if (!data) return;

    let needsSave = false;

    // Clean up legacy fields
    if (data.chatsFolder !== undefined) {
      delete data.chatsFolder;
      needsSave = true;
    }
    // Restore the pre-1.10 configurable skills folder under its current name.
    if (typeof data.skillsFolderPath === "string" && data.skillsFolder === undefined) {
      data.skillsFolder = data.skillsFolderPath;
      delete data.skillsFolderPath;
      needsSave = true;
    }

    if (needsSave) {
      // The caller must handle saving the modified data
      // Since we can't directly save plugin data from here, we emit an event
      this.settingsEmitter.emit("migration-data-modified", data);
    }
  }

}
