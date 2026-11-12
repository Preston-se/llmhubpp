import { Notice,type App } from 'obsidian';
import { LlmHubPlugin } from './plugin';
import SafeGuardRuntime from './safeguard/runtime.js';
import { initializeUnifiedStorage } from './migration/unifiedStorage';
import { installInboxPreset } from './migration/installPreset';
import { migrateLegacyHotkeys } from './migration/legacyHotkeys';
import { getStoragePaths } from './core/storagePaths';
import {recoverConfigurationFiles} from './configuration/recovery';
type ConfigurationLifecycleApp=App & {llmhubppConfigurationDrain?:Promise<void>};

export class UnifiedPlugin extends LlmHubPlugin {
  safeGuard?: SafeGuardRuntime;
  private stopping = false;
  private hostStarted = false;
  private stylesReady?: Promise<void>;

  // Obsidian normally loads CSS after awaiting onload. Proxy retries must not
  // leave the already-rendered views unstyled for that entire wait.
  loadCSS(): Promise<void> {
    if (!this.stylesReady) {
      const base = LlmHubPlugin.prototype as LlmHubPlugin & {loadCSS(): Promise<void>};
      this.stylesReady = base.loadCSS.call(this);
    }
    return this.stylesReady;
  }

  async onload(): Promise<void> {
    await (this.app as ConfigurationLifecycleApp).llmhubppConfigurationDrain;
    await this.loadCSS();
    const plugins = (this.app as unknown as {plugins?: {enabledPlugins?: Set<string>}}).plugins;
    if (['llm-hub', 'llm-hub-safe-guard', 'local-llm-hub'].some(id => plugins?.enabledPlugins?.has(id))) {
      const message = 'Disable the legacy LLM Hub and Safe Guard plugins before enabling Llmhub++.';
      new Notice(message, 0);
      throw new Error(message);
    }
    const dir = this.manifest.dir;
    if (!dir) throw new Error('Plugin directory is unavailable.');
    this.configurationRecoveryMode=!await recoverConfigurationFiles(this.app,dir);
    // Recover pending configuration writes before the compatibility loader resolves storage paths.
    await initializeUnifiedStorage(this.app.vault.adapter, this.app.vault.configDir, dir);
    if (await migrateLegacyHotkeys(this.app.vault.adapter, this.app.vault.configDir, dir)) {
      const manager = (this.app as unknown as {hotkeyManager?: {load(): Promise<void>}}).hotkeyManager;
      await manager?.load();
    }
    if (this.stopping) return;
    this.hostStarted = true;
    await super.onload();
    await this.ready;
    if (this.stopping) return;
    if(this.configurationRecoveryMode){await this.initializeConfiguration();return;}
    // The full package provides preset assets. Installation checks existing workspace files before writing.
    await installInboxPreset(this.app, dir, this.settings.workspaceFolder, getStoragePaths(this.settings, this.app.vault.configDir).tools);
    if (this.stopping) return;
    const guard = new SafeGuardRuntime(this);
    this.safeGuard = guard;
    this.addChild(guard);
    guard.load();
    try { await guard.ready; }
    catch (error) {
      guard.unload();
      throw error;
    }
    if (!this.stopping) await this.initializeConfiguration();
  }

  onunload(): void {
    this.stylesReady = undefined;
    this.stopping = true;
    const finish=()=>{this.safeGuard?.unload();if(this.hostStarted)super.onunload();};
    if(this.configuration){const draining=this.configuration.dispose().finally(finish);(this.app as ConfigurationLifecycleApp).llmhubppConfigurationDrain=draining;void draining.catch(()=>{});}else finish();
  }
}
