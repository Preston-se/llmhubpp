import { Setting, Notice } from "obsidian";
import { getLocalRagStore } from "src/core/localRagStore";
import { fetchEmbeddingModels } from "src/core/embeddingProvider";
import { t } from "src/i18n";
import { DEFAULT_GEMINI_EMBEDDING_MODEL, DEFAULT_RAG_SETTING } from "src/types";
import { embeddingDestinationIdentity, resolveEmbeddingConnection } from "src/core/embeddingCredentials";
import type { RagSetting } from "src/types";
import { ConfirmModal } from "src/ui/components/ConfirmModal";
import { formatError } from "obsidian-llm-hub-common/core";
import { setDestructiveButton } from "obsidian-llm-hub-common/obsidian";
import {
  addExcludePatternsSetting,
  addRagSettingHeader,
  addRagSettingSelector,
  addTargetFoldersSetting,
  useSettingTextArea,
  type RagIndexScope,
} from "obsidian-llm-hub-common/settings";
import { markRagKeyConfiguredElsewhere } from "./credentialStorageSettings";
import type { SettingsContext } from "./settingsContext";
import { displayRagIdleSettings, displayRagLifecycleSettings } from './ragLifecycleSettings';
import { settingsText as tr } from './settingsText';

type RagSettingMode = "internal" | "combined" | "external";

function getEffectiveEmbeddingModel(ragSetting: RagSetting): string {
  return ragSetting.embeddingModel || (ragSetting.embeddingBaseUrl ? "" : DEFAULT_GEMINI_EMBEDDING_MODEL);
}

function hasSameEmbeddingConfig(a: RagSetting, b: RagSetting): boolean {
  return a.embeddingBaseUrl.trim() === b.embeddingBaseUrl.trim()
    && getEffectiveEmbeddingModel(a) === getEffectiveEmbeddingModel(b);
}

function addEmbeddingDestinationSetting(container: HTMLElement, ctx: SettingsContext, name: string, setting: RagSetting, description: string): void {
  let value = setting.embeddingBaseUrl;
  new Setting(container).setName(t('settings.localEmbeddingBaseUrl')).setDesc(description)
    .addText(text => text.setPlaceholder(t('settings.localEmbeddingBaseUrl.placeholder')).setValue(value).onChange(next => { value = next.trim(); }))
    .addButton(button => button.setButtonText(tr('Save address', '保存地址')).onClick(async () => {
      const next = value;
      button.setDisabled(true);
      try {
        const previous = ctx.plugin.getRagSetting(name);
        if (!previous || next === previous.embeddingBaseUrl) return;
        const destination = embeddingDestinationIdentity(next);
        let priorDestination: string | undefined;
        try { priorDestination = embeddingDestinationIdentity(previous.embeddingBaseUrl); } catch { /* The saved address can be corrected here. */ }
        const clearKey = priorDestination !== destination && !!(previous.embeddingApiKey || previous.embeddingApiKeyConfigured);
        if (clearKey && !await new ConfirmModal(ctx.plugin.app,
          tr('The saved credential belongs to the current address. Save the new address and clear that credential?', '现有凭据属于当前地址。保存新地址并清空原凭据？'),
          tr('Clear credential and save', '清空凭据并保存'), t('common.cancel')).openAndWait()) return;
        await ctx.plugin.updateRagSetting(name, { embeddingBaseUrl: next, ...(clearKey ? { embeddingApiKey: '' } : {}) });
        ctx.display();
      } catch {
        new Notice(tr('Could not save the embedding address. Check the URL and try again.', '未能保存嵌入地址，请检查地址后重试。'));
      } finally { button.setDisabled(false); }
    }));
}

export function displayRagSettings(containerEl: HTMLElement, ctx: SettingsContext): void {
  const { plugin, display } = ctx;

  new Setting(containerEl).setName(t("settings.rag")).setHeading();
  displayRagIdleSettings(containerEl, ctx);

  const selectedName = plugin.workspaceState.selectedRagSetting;
  addRagSettingSelector(containerEl, plugin, selectedName, display);

  // Show selected RAG setting details
  if (selectedName) {
    const ragSetting = plugin.getRagSetting(selectedName);
    if (ragSetting) {
      displaySelectedRagSetting(containerEl, ctx, selectedName, ragSetting);
    }
  }
}

function displaySelectedRagSetting(
  containerEl: HTMLElement,
  ctx: SettingsContext,
  name: string,
  ragSetting: RagSetting
): void {
  const { plugin, display } = ctx;

  if (ragSetting.sourceCollection) {
    new Setting(containerEl).setName(name).setDesc(t("settings.sourceCollectionLocked"));
  } else addRagSettingHeader(containerEl, plugin, name, display);

  // All RAG is now local - go directly to local store settings
  displayLocalStoreSettings(containerEl, ctx, name, ragSetting);
}

function displayLocalStoreSettings(
  containerEl: HTMLElement,
  ctx: SettingsContext,
  name: string,
  ragSetting: RagSetting
): void {
  const { plugin, display } = ctx;
  const app = plugin.app;
  const isExternal = !!ragSetting.externalIndexPath;
  const isBundle = ragSetting.sourceRagSettings.length > 0;
  const mode: RagSettingMode = isBundle ? "combined" : isExternal ? "external" : "internal";
  const internalSourceNames = plugin.getRagSettingNames().filter(sourceName => {
    if (sourceName === name) return false;
    const source = plugin.getRagSetting(sourceName);
    return !!source && !source.externalIndexPath && source.sourceRagSettings.length === 0;
  });
  const sourceCompatibilityAnchorName = ragSetting.sourceRagSettings.find(sourceName =>
    internalSourceNames.includes(sourceName)
  ) ?? internalSourceNames[0];
  const sourceCompatibilityAnchor = sourceCompatibilityAnchorName
    ? plugin.getRagSetting(sourceCompatibilityAnchorName)
    : null;
  const compatibleSourceNames = sourceCompatibilityAnchor
    ? internalSourceNames.filter(sourceName => {
      const source = plugin.getRagSetting(sourceName);
      return !!source && hasSameEmbeddingConfig(sourceCompatibilityAnchor, source);
    })
    : [];

  // RAG index mode
  new Setting(containerEl)
    .setName(t("settings.ragMode"))
    .setDesc(ragSetting.sourceCollection ? t("settings.sourceCollectionLocked") : t("settings.ragMode.desc"))
    .addDropdown((dropdown) => {
      dropdown
        .addOption("internal", t("settings.ragMode.internal"))
        .addOption("combined", t("settings.ragMode.combined"))
        .addOption("external", t("settings.ragMode.external"))
        .setValue(mode)
        .setDisabled(!!ragSetting.sourceCollection)
        .onChange((value) => {
          const nextMode = value as RagSettingMode;
          const compatibleSelectedSources = ragSetting.sourceRagSettings.filter(sourceName =>
            compatibleSourceNames.includes(sourceName)
          );
          const sourceRagSettings = nextMode === "combined"
            ? (compatibleSelectedSources.length > 0 ? compatibleSelectedSources : compatibleSourceNames.slice(0, 1))
            : [];
          const externalIndexPath = nextMode === "external" ? (ragSetting.externalIndexPath || " ") : "";
          void (async () => {
            await plugin.updateRagSetting(name, { sourceRagSettings, externalIndexPath });
            getLocalRagStore()?.setExternalPath(name, externalIndexPath);
            getLocalRagStore()?.setSourceRagSettings(name, sourceRagSettings);
            display();
          })();
        });
    });

  if (isBundle) {
    const sourceSetting = new Setting(containerEl)
      .setName(t("settings.ragSourceSettings"))
      .setDesc(t("settings.ragSourceSettings.desc"));
    const sourceContainer = sourceSetting.controlEl.createDiv({ cls: "llm-hub-rag-source-settings" });
    if (compatibleSourceNames.length === 0) {
      sourceContainer.setText(t("settings.ragSourceSettings.empty"));
    } else {
      for (const sourceName of compatibleSourceNames) {
        const label = sourceContainer.createEl("label", { cls: "llm-hub-rag-source-setting-option" });
        const checkbox = label.createEl("input", {
          type: "checkbox",
          value: sourceName,
        });
        checkbox.checked = ragSetting.sourceRagSettings.includes(sourceName);
        label.createSpan({ text: sourceName });
        checkbox.addEventListener("change", () => {
          void (async () => {
            const nextSources = checkbox.checked
              ? [...ragSetting.sourceRagSettings, sourceName]
              : ragSetting.sourceRagSettings.filter(item => item !== sourceName);
            const uniqueSources = [...new Set(nextSources)].filter(item => compatibleSourceNames.includes(item));
            await plugin.updateRagSetting(name, { sourceRagSettings: uniqueSources });
            getLocalRagStore()?.setSourceRagSettings(name, uniqueSources);
            display();
          })();
        });
      }
    }

    displayTopKSetting(containerEl, plugin, name, ragSetting, display);
    displayScoreThresholdSetting(containerEl, plugin, name, ragSetting, display);
    displayIndexStatus(containerEl, app, name, ragSetting);
    for(const sourceName of [...new Set(ragSetting.sourceRagSettings)]){
      const source=plugin.getRagSetting(sourceName);
      if(source&&!source.externalIndexPath&&!source.sourceRagSettings.length)new Setting(containerEl).setName(sourceName)
        .addButton(button=>button.setButtonText(t('settings.localSyncBtn')).onClick(()=>{void plugin.syncVaultForLocalRAG(sourceName).catch(error=>new Notice(formatError(error)));}));
    }
  } else if (isExternal) {
    const refreshExternalIndexModel = displayExternalIndexModel(containerEl, app, name);

    // --- External index mode ---
    // External Index Path
    const externalPathSetting = new Setting(containerEl)
      .setName(t("settings.externalIndexPath"))
      .setDesc(t("settings.externalIndexPath.desc"));
    externalPathSetting
      .addTextArea((text) => {
        text
          .setPlaceholder(t("settings.externalIndexPath.placeholder"))
          .setValue(ragSetting.externalIndexPath.trim())
          .onChange((value) => {
            void (async () => {
              const path = value.trim() || " "; // keep toggle on
              await plugin.updateRagSetting(name, { externalIndexPath: path });
              getLocalRagStore()?.setExternalPath(name, path);
              refreshExternalIndexModel();
            })();
          });
        useSettingTextArea(externalPathSetting, text.inputEl);
      });

    // Embedding server URL for query embedding
    addEmbeddingDestinationSetting(containerEl, ctx, name, ragSetting, t("settings.externalEmbeddingBaseUrl.desc"));

    // Embedding API Key (optional)
    const embeddingKeySetting = new Setting(containerEl)
      .setName(t("settings.localEmbeddingApiKey"))
      .setDesc(t("settings.localEmbeddingApiKey.desc"))
      .addText((text) => {
        text
          .setPlaceholder(t("settings.localEmbeddingApiKey.placeholder"))
          .setValue(ragSetting.embeddingApiKey)
          .onChange((value) => {
            void (async () => {
              await plugin.updateRagSetting(name, { embeddingApiKey: value.trim() });
            })();
          });
        text.inputEl.type = "password";
      });
    markRagKeyConfiguredElsewhere(embeddingKeySetting, plugin, ragSetting);

    // Top K (per-setting)
    displayTopKSetting(containerEl, plugin, name, ragSetting, display);

    // Score threshold
    displayScoreThresholdSetting(containerEl, plugin, name, ragSetting, display);

    // Index status
    displayIndexStatus(containerEl, app, name, ragSetting);
  } else {
    // --- Vault sync mode ---
    // Embedding server settings
    displayEmbeddingSettings(containerEl, ctx, name, ragSetting);

    // Top K (per-setting)
    displayTopKSetting(containerEl, plugin, name, ragSetting, display);

    // Which files this setting indexes
    const saveScope = (updates: Partial<RagIndexScope>) => plugin.updateRagSetting(name, updates);
    addTargetFoldersSetting(containerEl, ragSetting, saveScope);
    addExcludePatternsSetting(containerEl, ragSetting, saveScope);

    // Index status
    displayIndexStatus(containerEl, app, name, ragSetting);

    // Sync
    displaySyncControls(containerEl, ctx, name);
    displayRagLifecycleSettings(containerEl, ctx, name, ragSetting);

    // Clear index
    new Setting(containerEl)
      .setName(t("settings.localClearIndex"))
      .setDesc(t("settings.localClearIndex.desc"))
      .addButton((btn) =>
        setDestructiveButton(btn.setButtonText(t("settings.localClearIndex")))
          .onClick(() => {
            void (async () => {
              const confirmed = await new ConfirmModal(
                app,
                t("settings.localClearConfirm"),
                t("common.delete"),
                t("common.cancel")
              ).openAndWait();
              if (!confirmed) return;

              try {
                await plugin.clearLocalRagIndex(name);
                new Notice(t("settings.localIndexCleared"));
                display();
              } catch (error) {
                new Notice(formatError(error));
              }
            })();
          })
      );
  }
}

/** Embedding server fields (URL, API key, model, chunk size/overlap) */
function displayEmbeddingSettings(
  containerEl: HTMLElement,
  ctx: SettingsContext,
  name: string,
  ragSetting: RagSetting
): void {
  const { plugin } = ctx;
  // Custom Embedding Base URL
  addEmbeddingDestinationSetting(containerEl, ctx, name, ragSetting, t("settings.localEmbeddingBaseUrl.desc"));

  // Custom Embedding API Key
  const customEmbeddingKeySetting = new Setting(containerEl)
    .setName(t("settings.localEmbeddingApiKey"))
    .setDesc(t("settings.localEmbeddingApiKey.desc"))
    .addText((text) => {
      text
        .setPlaceholder(t("settings.localEmbeddingApiKey.placeholder"))
        .setValue(ragSetting.embeddingApiKey)
        .onChange((value) => {
          void (async () => {
            await plugin.updateRagSetting(name, { embeddingApiKey: value.trim() });
          })();
        });
      text.inputEl.type = "password";
    });
  markRagKeyConfiguredElsewhere(customEmbeddingKeySetting, plugin, ragSetting);

  // Embedding model (dropdown + fetch button, fallback to text input)
  const embeddingModelSetting = new Setting(containerEl)
    .setName(t("settings.localEmbeddingModel"))
    .setDesc(t("settings.localEmbeddingModel.desc"));

  let embeddingDropdown: HTMLSelectElement | null = null;
  let embeddingModelInput: HTMLInputElement | null = null;

  // Dropdown (primary)
  embeddingModelSetting.controlEl.createEl("select", {}, (select) => {
    embeddingDropdown = select;
    select.addClass("dropdown");
    if (!ragSetting.embeddingModel) {
      const placeholder = select.createEl("option", { text: t("settings.localEmbeddingModel.desc"), value: "" });
      placeholder.disabled = true;
      placeholder.selected = true;
    } else {
      const opt = select.createEl("option", { text: ragSetting.embeddingModel, value: ragSetting.embeddingModel });
      opt.selected = true;
    }
    select.addEventListener("change", () => {
      void plugin.updateRagSetting(name, { embeddingModel: select.value });
    });
  });

  // Text input (hidden by default, shown when fetch fails)
  embeddingModelSetting.addText((text) => {
    embeddingModelInput = text.inputEl;
    text
      .setPlaceholder(t("settings.localEmbeddingModel.desc"))
      .setValue(ragSetting.embeddingModel)
      .onChange((value) => {
        void plugin.updateRagSetting(name, { embeddingModel: value.trim() });
      });
    text.inputEl.addClass("llm-hub-hidden");
  });

  embeddingModelSetting.addButton((btn) =>
    btn
      .setButtonText(t("settings.localLlmModal.fetchModels"))
      .onClick(async () => {
        btn.setButtonText(t("settings.localLlmModal.fetching"));
        btn.setDisabled(true);
        try {
          const current = plugin.getRagSetting(name) ?? ragSetting;
          const connection = resolveEmbeddingConnection(current, plugin.settings);
          if (connection.status !== 'ready') throw new Error(t('sync.errorEmbeddingMissing'));
          const models = await fetchEmbeddingModels(connection.apiKey, connection.baseUrl, plugin.settings.proxyUrl, plugin.settings.proxyBypass);
          if (models.length === 0) {
            // Show text input as fallback
            if (embeddingDropdown) embeddingDropdown.addClass("llm-hub-hidden");
            if (embeddingModelInput) embeddingModelInput.removeClass("llm-hub-hidden");
            new Notice(t("settings.localLlmModal.noModelsFound"));
            return;
          }
          // Show dropdown, hide text input
          if (embeddingDropdown) embeddingDropdown.removeClass("llm-hub-hidden");
          if (embeddingModelInput) embeddingModelInput.addClass("llm-hub-hidden");
          if (embeddingDropdown) {
            embeddingDropdown.empty();
            for (const model of models) {
              const opt = embeddingDropdown.createEl("option", { text: model, value: model });
              if (model === current.embeddingModel) {
                opt.selected = true;
              }
            }
            if (!current.embeddingModel || !models.includes(current.embeddingModel)) {
              const selected = models[0];
              await plugin.updateRagSetting(name, { embeddingModel: selected });
              embeddingDropdown.value = selected;
            }
          }
          new Notice(t("settings.localLlmModal.modelsLoaded", { count: String(models.length) }));
        } catch (err) {
          new Notice(`Error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          btn.setButtonText(t("settings.localLlmModal.fetchModels"));
          btn.setDisabled(false);
        }
      })
  );

  // Chunk size
  new Setting(containerEl)
    .setName(t("settings.localChunkSize"))
    .setDesc(t("settings.localChunkSize.desc"))
    .addSlider((slider) =>
      slider
        .setLimits(100, 2000, 50)
        .setValue(ragSetting.chunkSize)
        .onChange((value) => {
          void (async () => {
            await plugin.updateRagSetting(name, { chunkSize: value });
          })();
        })
    );

  // Chunk overlap
  new Setting(containerEl)
    .setName(t("settings.localChunkOverlap"))
    .setDesc(t("settings.localChunkOverlap.desc"))
    .addSlider((slider) =>
      slider
        .setLimits(0, 500, 10)
        .setValue(ragSetting.chunkOverlap)
        .onChange((value) => {
          void (async () => {
            await plugin.updateRagSetting(name, { chunkOverlap: value });
          })();
        })
    );

  // PDF chunk pages
  new Setting(containerEl)
    .setName(t("settings.localPdfChunkPages"))
    .setDesc(t("settings.localPdfChunkPages.desc"))
    .addSlider((slider) =>
      slider
        .setLimits(1, 6, 1)
        .setValue(ragSetting.pdfChunkPages ?? 6)
        .onChange((value) => {
          void (async () => {
            await plugin.updateRagSetting(name, { pdfChunkPages: value });
          })();
        })
    );

  // indexMultimodal is now automatically determined by embedding model (gemini-embedding-*)
}

/** Show embedding model detected from external index (read-only) */
function displayExternalIndexModel(
  containerEl: HTMLElement,
  app: SettingsContext["plugin"]["app"],
  name: string
): () => void {
  const modelSetting = new Setting(containerEl)
    .setName(t("settings.externalIndexModel"))
    .setDesc(t("settings.externalIndexModel.desc"));

  const modelDisplay = modelSetting.controlEl.createSpan({
    text: t("settings.externalIndexModel.loading"),
  });

  const refresh = () => {
    const localRag = getLocalRagStore();
    if (!localRag) {
      modelDisplay.textContent = t("settings.externalIndexModel.notFound");
      return;
    }

    modelDisplay.textContent = t("settings.externalIndexModel.loading");
    void (async () => {
      const status = await localRag.getStatus(app, name);
      modelDisplay.textContent = status.embeddingModel || t("settings.externalIndexModel.notFound");
    })();
  };

  refresh();
  return refresh;
}

/** Top K slider */
function displayTopKSetting(
  containerEl: HTMLElement,
  plugin: SettingsContext["plugin"],
  name: string,
  ragSetting: RagSetting,
  display: () => void
): void {
  new Setting(containerEl)
    .setName(t("settings.retrievedChunksLimit"))
    .setDesc(t("settings.retrievedChunksLimit.desc"))
    .addSlider((slider) =>
      slider
        .setLimits(1, 20, 1)
        .setValue(ragSetting.topK)
        .onChange((value) => {
          void (async () => {
            await plugin.updateRagSetting(name, { topK: value });
          })();
        })
    )
    .addExtraButton((button) =>
      button
        .setIcon("reset")
        .setTooltip(t("settings.resetToDefault", { value: String(DEFAULT_RAG_SETTING.topK) }))
        .onClick(() => {
          void (async () => {
            await plugin.updateRagSetting(name, { topK: DEFAULT_RAG_SETTING.topK });
            display();
          })();
        })
    );
}

/** Score threshold slider */
function displayScoreThresholdSetting(
  containerEl: HTMLElement,
  plugin: SettingsContext["plugin"],
  name: string,
  ragSetting: RagSetting,
  display: () => void
): void {
  const currentValue = ragSetting.scoreThreshold ?? DEFAULT_RAG_SETTING.scoreThreshold;
  new Setting(containerEl)
    .setName(t("settings.scoreThreshold"))
    .setDesc(t("settings.scoreThreshold.desc"))
    .addSlider((slider) => {
      slider
        .setLimits(0, 10, 1)
        .setValue(Math.round(currentValue * 10))
        .onChange((value) => {
          void (async () => {
            await plugin.updateRagSetting(name, { scoreThreshold: value / 10 });
          })();
        });
      // Show 0.0-1.0 instead of 0-10
      const tooltipEl = slider.sliderEl.nextElementSibling;
      if (tooltipEl) {
        const updateTooltip = () => { tooltipEl.textContent = (slider.getValue() / 10).toFixed(1); };
        updateTooltip();
        slider.sliderEl.addEventListener("input", updateTooltip);
      }
    })
    .addExtraButton((button) =>
      button
        .setIcon("reset")
        .setTooltip(t("settings.resetToDefault", { value: String(DEFAULT_RAG_SETTING.scoreThreshold) }))
        .onClick(() => {
          void (async () => {
            await plugin.updateRagSetting(name, { scoreThreshold: DEFAULT_RAG_SETTING.scoreThreshold });
            display();
          })();
        })
    );
}

/** Index status display (chunk/file count) */
function displayIndexStatus(
  containerEl: HTMLElement,
  app: SettingsContext["plugin"]["app"],
  name: string,
  ragSetting: RagSetting
): void {
  const localRag = getLocalRagStore();
  const lastSync = ragSetting.lastFullSync
    ? new Date(ragSetting.lastFullSync).toLocaleString()
    : t("settings.syncStatusNever");

  const statusSetting = new Setting(containerEl)
    .setName(t("settings.localSyncStatus", { chunks: "0", files: "0" }))
    .setDesc(lastSync);

  if (localRag) {
    void (async () => {
      const status = await localRag.getStatus(app, name);
      statusSetting.setName(
        t("settings.localSyncStatus", {
          chunks: String(status.chunkCount),
          files: String(status.fileCount),
        })
      );
    })();
  }
}

/** Sync button + progress bar */
export function displaySyncControls(
  containerEl: HTMLElement,
  ctx: SettingsContext,
  name: string
): void {
  const { plugin, display, syncCancelRef } = ctx;
  const alreadySyncing = syncCancelRef.controllers.has(name);

  const progressContainer = containerEl.createDiv({
    cls: "llm-hub-sync-progress",
  });
  progressContainer.addClass("llm-hub-hidden");

  const progressText = progressContainer.createDiv();
  const progressBar = progressContainer.createEl("progress");
  progressBar.addClass("llm-hub-progress-bar");
  if (alreadySyncing) {
    progressContainer.removeClass("llm-hub-hidden");
    progressText.textContent = t("settings.localSyncing");
  }

  let cancelBtn: HTMLButtonElement | null = null;

  const syncSetting = new Setting(containerEl)
    .setName(t("settings.localSyncBtn"));

  syncSetting
    .addButton((btn) => {
      cancelBtn = btn.buttonEl;
      setDestructiveButton(btn.setButtonText(t("settings.cancelSync")))
        .onClick(() => {
          syncCancelRef.controllers.get(name)?.abort();
          new Notice(t("settings.cancellingSync"));
        });
      if (!alreadySyncing) btn.buttonEl.addClass("llm-hub-hidden");
    })
    .addButton((btn) =>
      btn
        .setButtonText(t(alreadySyncing ? "settings.localSyncing" : "settings.localSyncBtn"))
        .setCta()
        .setDisabled(alreadySyncing)
        .onClick(() => {
          void (async () => {
            if (syncCancelRef.controllers.has(name)) return;
            const controller = new AbortController();
            syncCancelRef.controllers.set(name, controller);
            btn.setDisabled(true);
            btn.setButtonText(t("settings.localSyncing"));
            if (cancelBtn) cancelBtn.removeClass("llm-hub-hidden");
            progressContainer.removeClass("llm-hub-hidden");
            progressText.removeClass("llm-hub-progress-error");
            progressText.textContent = t("settings.syncPreparing");
            progressBar.value = 0;
            progressBar.max = 100;

            try {
              const result = await plugin.syncVaultForLocalRAG(
                name,
                (current, total, fileName, action) => {
                  const percent = Math.round((current / total) * 100);
                  progressBar.value = percent;
                  progressBar.max = 100;

                  const actionText =
                    action === "embed"
                      ? t("settings.localSyncEmbedding")
                      : action === "skip"
                        ? t("settings.localSyncSkipping")
                        : t("settings.localSyncRemoving");
                  progressText.textContent = `${actionText}: ${fileName} (${current}/${total})`;
                },
                controller.signal,
              );
              if (result) {
                new Notice(
                  t("settings.localSyncResult", {
                    embedded: String(result.embedded),
                    skipped: String(result.skipped),
                    removed: String(result.removed),
                  })
                );
                if (result.failedFiles && result.failedFiles.length > 0) {
                  new Notice(t("settings.localSyncFilesFailed", {
                    count: String(result.failedFiles.length),
                    files: result.failedFiles.join("\n"),
                  }));
                }
                if (result.errors.length > 0) {
                  const errorSummary = result.errors.slice(0, 3).join("\n");
                  const suffix = result.errors.length > 3 ? `\n...and ${result.errors.length - 3} more` : "";
                  new Notice(`Sync errors:\n${errorSummary}${suffix}`, 10000);
                }
              }
            } catch (error) {
              const msg = formatError(error);
              if ((error instanceof Error && error.name === "AbortError") || controller.signal.aborted) {
                new Notice(t("settings.syncCancelled"));
                progressText.textContent = t("settings.syncCancelled");
              } else {
                new Notice(t("settings.syncFailed", { error: msg }));
                progressText.textContent = `${t("common.error")}${msg}`;
                progressText.addClass("llm-hub-progress-error");
              }
            } finally {
              btn.setDisabled(false);
              btn.setButtonText(t("settings.localSyncBtn"));
              if (cancelBtn) cancelBtn.addClass("llm-hub-hidden");
              if (syncCancelRef.controllers.get(name) === controller) syncCancelRef.controllers.delete(name);
              window.setTimeout(() => {
                progressContainer.addClass("llm-hub-hidden");
                display();
              }, 2000);
            }
          })();
        })
    );
}
