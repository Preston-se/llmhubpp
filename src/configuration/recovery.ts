import type { App } from 'obsidian';
import type { ConfigurationJournal, RawSnapshot, ConfigDomain } from './types';
import { assertSafe, restoreConfigurationValue } from './validation';
import { readSecretJson, clearSecret, writeSecretJson } from '../core/secretStorage';
import { getStoragePaths, ensureStorageDirectory } from '../core/storagePaths';
import { collectSettingsCredentials, collectRagCredentials, stripSettingsCredentials, stripWorkspaceCredentials, SETTINGS_CREDENTIAL_SECRET_ID, ragCredentialSecretId } from '../core/credentialBundle';
import type { LlmHubSettings, WorkspaceState } from '../types';
/** Runs before clients, source tasks and Safe Guard are initialized. Never runs legacy migrations. */
export async function recoverConfigurationFiles(app: App, pluginDir: string): Promise<boolean> {
    const adapter = app.vault.adapter, base = `${pluginDir}/configuration`, pending = `${base}/pending.json`;
    if (!await adapter.exists(pending))
        return true;
    const read = async (path: string): Promise<Record<string, unknown>> => await adapter.exists(path) ? JSON.parse(await adapter.read(path)) as Record<string, unknown> : {};
    try {
        const journal = JSON.parse(await adapter.read(pending)) as ConfigurationJournal | null;
        if (!journal)
            return true;
        assertSafe(journal);
        if (!Array.isArray(journal.domains) || journal.domains.some(d => !['settings', 'workspace', 'safeGuard', 'hotkeys', 'resources'].includes(d)))
            return false;
        const secure = readSecretJson<RawSnapshot>(app, 'llmhubpp-config-recovery');
        if (journal.hasSecrets && !secure)
            return false;
        const settingsPath = `${pluginDir}/data.json`, currentSettings = await read(settingsPath), beforeSettings = (secure?.settings ?? restoreConfigurationValue(journal.before.settings, currentSettings)) as LlmHubSettings;
        const paths = getStoragePaths(beforeSettings, app.vault.configDir);
        const domainPath: Record<Exclude<ConfigDomain, 'resources'>, string> = { settings: settingsPath, workspace: `${paths.state}/gemini-workspace.json`, safeGuard: `${pluginDir}/safe-guard.json`, hotkeys: `${app.vault.configDir}/hotkeys.json` };
        for (const domain of journal.domains) {
            if (domain === 'resources') {
                const saved = (secure?.resources ?? journal.before.resources), files = saved.files as Record<string, string> ?? {};
                for (const [path, content] of Object.entries(files)) {
                    if (path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || ![paths.tools, paths.skills, `${paths.workspace}/workflows`].some(root => path.startsWith(root + '/')))
                        return false;
                    if ((saved.absentPaths as string[] ?? []).includes(path)) {
                        if (await adapter.exists(path)) {
                            await ensureStorageDirectory(adapter, `${base}/recovered-resources`);
                            await adapter.rename(path, `${base}/recovered-resources/${crypto.randomUUID()}-${path.split('/').pop()}`);
                        }
                    }
                    else {
                        await ensureStorageDirectory(adapter, path.split('/').slice(0, -1).join('/'));
                        await adapter.write(path, content);
                    }
                }
                continue;
            }
            const path = domainPath[domain], current = await read(path);
            let value = secure?.[domain] ?? restoreConfigurationValue(journal.before[domain], domain === 'hotkeys' ? { bindings: Object.fromEntries(Object.entries(current).filter(([key]) => key.startsWith('llmhubpp:'))) } : current) as Record<string, unknown>;
            if (domain === 'hotkeys')
                value = { ...Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith('llmhubpp:'))), ...value.bindings as object };
            if (beforeSettings.credentialStorage === 'secretStorage' && secure) {
                if (domain === 'settings') {
                    if (!writeSecretJson(app, SETTINGS_CREDENTIAL_SECRET_ID, collectSettingsCredentials(value as unknown as LlmHubSettings)))
                        return false;
                    value = stripSettingsCredentials(value as unknown as LlmHubSettings) as unknown as Record<string, unknown>;
                }
                if (domain === 'workspace') {
                    if (!writeSecretJson(app, ragCredentialSecretId(paths.workspace), collectRagCredentials(value as unknown as WorkspaceState)))
                        return false;
                    value = stripWorkspaceCredentials(value as unknown as WorkspaceState) as unknown as Record<string, unknown>;
                }
            }
            await ensureStorageDirectory(adapter, path.split('/').slice(0, -1).join('/'));
            await adapter.write(path, JSON.stringify(value, null, 2));
        }
        await adapter.write(pending, 'null');
        clearSecret(app, 'llmhubpp-config-recovery');
        return true;
    }
    catch {
        return false;
    }
}
