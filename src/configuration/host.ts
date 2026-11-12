import type { App } from 'obsidian';
import type { LlmHubSettings, WorkspaceState } from '../types';
import { DEFAULT_RAG_SETTING, DEFAULT_SETTINGS, DEFAULT_WORKSPACE_STATE } from '../types';
import { getStoragePaths, ensureStorageDirectory } from '../core/storagePaths';
import { readSecretJson, writeSecretJson, clearSecret } from '../core/secretStorage';
import { ConfigurationService, canonical, digest } from './service';
import { createRegistry } from './registry';
import { mergeObject, redact, restoreConfigurationValue } from './validation';
import { ConfigurationError, type RawSnapshot, type ConfigDomain, type ConfigOperation, type ConfigurationJournal, type ConfigHistoryEntry } from './types';
import { ConfigurationMcpServer } from './mcp/server';
import { checkConfiguration, probeEndpoint } from './checks';
import { exportConfigurationBundle, inspectConfigurationBundle } from './bundle/codec';
import { previewConfigurationImport, type ImportChoices } from './bundle/import';
import type { BundleInspection } from './bundle/codec';
import { getConfigurationStatus } from './diagnostics';
interface Guard {
    getConfigurationRuntimeStatus?:()=>Record<string,unknown>;
    reloadConfigurationProxy?:()=>Promise<Record<string,unknown>>;
    settings: Record<string, unknown>;
    saveSettings(): Promise<void>;
    resetSessionReadOnly?: (reason: string) => void;
    clearConversationPinnedRoute?: (notify: boolean) => void;
    clearActualRouteChip?: () => void;
    ensureAutoPanelControls?: () => void;
    routeUiState?: unknown;
}
export interface ConfigurationHost {
    app: App;
    manifest: {
        dir?: string;
        version?: string;
    };
    settings: LlmHubSettings;
    workspaceState: WorkspaceState;
    saveSettings(): Promise<void>;
    saveWorkspaceState(): Promise<void>;
    getWorkspaceStateFilePath(): string;
    safeGuard?: Guard;
    tasks: {
        hasUnfinished(): boolean;
    };
    settingsEmitter: {
        emit(name: string, value: unknown): void;
    };
    configuration?: HostConfiguration;
    setWorkspaceConfigurationSaver?: (save: (value: WorkspaceState) => Promise<void>) => void;
    persistWorkspaceConfiguration?: () => Promise<void>;
    activateWorkspaceConfiguration?: () => void;
    peekRagConfigurationStatus?:(name:string)=>Record<string,unknown>|undefined;
}
const clone = <T>(v: T): T => structuredClone(v);
const reloadingHosts=new WeakSet<HostConfiguration>();
/** Never closes or replaces the configuration MCP server. */
export async function reloadConfiguration(configuration:HostConfiguration,args:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>{
    if(Object.keys(args).some(key=>!['baseRevision','scopes'].includes(key))||typeof args.baseRevision!=='string'||!Array.isArray(args.scopes)||!args.scopes.length||args.scopes.length>2||new Set(args.scopes).size!==args.scopes.length||args.scopes.some(scope=>!['safeGuard','clients'].includes(String(scope))))throw new ConfigurationError('invalid-arguments');
    if(configuration.service.recoveryRequired)throw new ConfigurationError('recovery-required');
    const snapshot=await configuration.service.inspectSnapshot();
    if(snapshot.revision!==args.baseRevision)throw new ConfigurationError('conflict',[],{currentRevision:snapshot.revision});
    if(signal?.aborted)throw new ConfigurationError('reload-cancelled');
    const host=configuration.host,runtime=host.safeGuard?.getConfigurationRuntimeStatus?.();
    if(host.tasks.hasUnfinished()||Number(runtime?.activeRequests)>0||runtime?.reloading||reloadingHosts.has(configuration))throw new ConfigurationError('busy');
    reloadingHosts.add(configuration);
    const applied:string[]=[],paths=configuration.service.getReloadState().paths;
    try{
        if(args.scopes.includes('safeGuard')){
            const target=paths.filter(path=>['safeGuard.listenHost','safeGuard.listenPort'].includes(path));
            if(target.length&&host.safeGuard?.reloadConfigurationProxy){
                const result=await host.safeGuard.reloadConfigurationProxy();
                if(result.reason==='busy')throw new ConfigurationError('busy');
                if(result.applied&&result.runtime==='listening'&&result.host===snapshot.raw.safeGuard.listenHost&&result.port===snapshot.raw.safeGuard.listenPort)applied.push(...target);
            }
        }
        if(args.scopes.includes('clients')&&host.settingsEmitter){
            host.activateWorkspaceConfiguration?.();
            host.settingsEmitter.emit('settings-updated',host.settings);
            const live=configuration.service.describe().filter(field=>field.effect==='live').map(field=>field.moduleId+'.'+field.fieldId);
            applied.push(...paths.filter(path=>!path.startsWith('safeGuard.')&&live.some(root=>path===root||path.startsWith(root+'.'))));
        }
        const current=(await configuration.service.read()).revision;
        if(current!==args.baseRevision)throw new ConfigurationError('conflict',[],{currentRevision:current});
        if(signal?.aborted)throw new ConfigurationError('reload-cancelled');
        configuration.service.markActivated(applied);
        const pending=configuration.service.getReloadState().paths;
        const manual=pending.some(path=>!['safeGuard.listenHost','safeGuard.listenPort'].includes(path));
        return {revision:current,status:manual?'manual-action-required':pending.length?'pending':'applied',applied,pending,
            localSteps:manual?['等待当前任务结束，在 Obsidian 本地重载 Llmhub++ 插件。','重载后重新开启 Agent 辅助配置，更新已失效的临时连接令牌，再用 status 复查。']:pending.length?['代理尚未在目标地址监听，检查端口与本地启动错误后再尝试。']:[]};
    }finally{reloadingHosts.delete(configuration);}
}
export class HostConfiguration {
    readonly service: ConfigurationService;
    readonly mcp: ConfigurationMcpServer;
    private baseline!: RawSnapshot;
    private rawSettings: () => Promise<void>;
    private rawWorkspace: () => Promise<void>;
    private rawGuard?: () => Promise<void>;
    private base: string;
    private originalSave: () => Promise<void>;
    private originalWorkspace: () => Promise<void>;
    private disposed = false;
    private uiQueue: Promise<unknown> = Promise.resolve();
    private uiLineage = new Map<string, string>();
    private guardBefore: Record<string, unknown> = {};
    private modals=new Set<{close():void;onClose():void}>();
    constructor(readonly host: ConfigurationHost) {
        this.base = `${host.manifest.dir}/configuration`;
        this.originalSave = host.saveSettings.bind(host);
        this.originalWorkspace = host.saveWorkspaceState.bind(host);
        this.rawSettings = this.originalSave;
        this.rawWorkspace = host.persistWorkspaceConfiguration?.bind(host) ?? this.originalWorkspace;
        this.rawGuard = host.safeGuard?.saveSettings.bind(host.safeGuard);
        this.service = new ConfigurationService(createRegistry({ settings: DEFAULT_SETTINGS as unknown as Record<string, unknown>, workspace: DEFAULT_WORKSPACE_STATE as unknown as Record<string, unknown> }), {
            read: () => this.readRaw(), write: (domain, value, phase) => this.write(domain, value, phase), activate: async (domains) => {
                if (this.disposed)
                    return { reloadRequired: true };
                if (domains.includes('workspace')) {
                    host.activateWorkspaceConfiguration?.();
                    host.settingsEmitter.emit('workspace-state-loaded', host.workspaceState);
                    host.settingsEmitter.emit('rag-setting-changed', host.workspaceState.selectedRagSetting);
                    host.settingsEmitter.emit('search-selection-changed', { ragSetting: host.workspaceState.selectedRagSetting, webSearch: host.workspaceState.webSearchEnabled });
                }
                if (domains.includes('safeGuard') && host.safeGuard) {
                    const guard = host.safeGuard, old = this.guardBefore;
                    if (old.routerEnabled !== guard.settings.routerEnabled) {
                        if (!guard.settings.routerEnabled) {
                            guard.clearConversationPinnedRoute?.(false);
                            guard.routeUiState = null;
                            guard.clearActualRouteChip?.();
                        }
                        guard.ensureAutoPanelControls?.();
                    }
                    if (guard.settings.defaultReadOnlyEnabled && (!old.defaultReadOnlyEnabled || !old.syncLlmHubUi && guard.settings.syncLlmHubUi))
                        guard.resetSessionReadOnly?.('配置更新');
                }
                host.settingsEmitter.emit('settings-updated', host.settings);
                return { reloadRequired: false };
            },
            validate: (before, after, ops) => this.validate(before, after, ops),
            journal: (value, before) => this.saveJournal(value, before), loadJournal: () => this.loadJournal(),
            recordHistory: entries => this.writeJson('history.json', entries),
            loadHistory: () => this.readJson<ConfigHistoryEntry[]>(`${this.base}/history.json`, []),
        });
        this.mcp = new ConfigurationMcpServer(this.service, {
            status:answers=>getConfigurationStatus({service:this.service,pluginVersion:host.manifest.version,guardRuntime:()=>host.safeGuard?.getConfigurationRuntimeStatus?.()??{runtime:'unknown'},reloadState:()=>this.service.getReloadState(),ragRuntime:async name=>host.peekRagConfigurationStatus?.(name)},answers),
            reload:(args,signal)=>reloadConfiguration(this,args,signal??this.mcp.getSignal()),
            check: (args, signal) => checkConfiguration(this, args, signal ?? this.mcp.getSignal()),
            probe:(args,signal)=>probeEndpoint(this.host,args,signal??this.mcp.getSignal()),
            export: async (args) => this.mcp.putDownload(await exportConfigurationBundle(await this.exportRaw(), { version: host.manifest.version ?? '1.261107.2', modules: args.modules as string[] | undefined, includeResources: args.includeResources === true })),
            importPreview: async (args) => { const choices = args.choices as ImportChoices ?? {}; if (choices.password)
                throw new ConfigurationError('local-password-required'); const bundle = await inspectConfigurationBundle(this.mcp.getUpload(String(args.uploadHandle))); return previewConfigurationImport(this.service, await this.prepareImport(bundle, choices), bundle, choices); },
        });
    }
    async initialize(): Promise<void> {
        const hotkeys = await this.readJson<Record<string, unknown>>(`${this.host.app.vault.configDir}/hotkeys.json`, {});
        this.baseline = { settings: clone(this.host.settings) as unknown as Record<string, unknown>, workspace: clone(this.host.workspaceState) as unknown as Record<string, unknown>, safeGuard: clone(this.host.safeGuard?.settings ?? {}), hotkeys: { bindings: this.onlyOwnHotkeys(hotkeys) }, resources: { files: {} } };
        await this.stabilizeCollections(this.baseline.settings);
        this.assign('settings', this.baseline.settings);
        await this.service.recover();
        this.host.saveSettings = () => this.saveUi('settings', this.host.settings as unknown as Record<string, unknown>);
        this.host.saveWorkspaceState = () => this.saveUi('workspace', this.host.workspaceState as unknown as Record<string, unknown>);
        this.host.setWorkspaceConfigurationSaver?.(value => this.saveUi('workspace', value as unknown as Record<string, unknown>));
        if (this.host.safeGuard)
            this.host.safeGuard.saveSettings = () => this.saveUi('safeGuard', this.host.safeGuard!.settings);
        this.host.configuration = this;
    }
    private onlyOwnHotkeys(all: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(all).filter(([id]) => id.startsWith('llmhubpp:'))); }
    private async readJson<T>(path: string, fallback: T): Promise<T> { const a = this.host.app.vault.adapter; return await a.exists(path) ? JSON.parse(await a.read(path)) as T : fallback; }
    private async writeJson(name: string, value: unknown): Promise<void> { await ensureStorageDirectory(this.host.app.vault.adapter, this.base); await this.host.app.vault.adapter.write(`${this.base}/${name}`, JSON.stringify(value, null, 2)); }
    async readRaw(): Promise<RawSnapshot> {
        const snapshot = clone(this.baseline), adapter = this.host.app.vault.adapter;
        const paths = [`${this.host.manifest.dir}/data.json`, this.host.getWorkspaceStateFilePath(), `${this.host.manifest.dir}/safe-guard.json`];
        const disk = await Promise.all(paths.map(async (path) => await adapter.exists(path) ? await adapter.read(path) : ''));
        snapshot.resources.__externalRevision = await digest(disk);
        snapshot.hotkeys.bindings = this.onlyOwnHotkeys(await this.readJson<Record<string, unknown>>(`${this.host.app.vault.configDir}/hotkeys.json`, {}));
        const resources = snapshot.resources.files as Record<string, string>;
        const absent: string[] = [];
        for (const path of Object.keys(resources)) {
            if (await adapter.exists(path))
                resources[path] = await adapter.read(path);
            else {
                resources[path] = '';
                absent.push(path);
            }
        }
        snapshot.resources.absentPaths = absent;
        return snapshot;
    }
    async inspectResources(paths: string[]): Promise<void> {
        if (paths.length > 1000)
            throw new ConfigurationError('bundle-limit');
        const files = this.baseline.resources.files as Record<string, string>;
        for (const path of paths) {
            this.assertResourcePath(path);
            files[path] = await this.host.app.vault.adapter.exists(path) ? await this.host.app.vault.adapter.read(path) : '';
        }
    }
    async prepareImport(bundle: BundleInspection, choices: ImportChoices = {}): Promise<RawSnapshot> {
        const paths = Object.keys(bundle.snapshot.resources?.files as Record<string, string> ?? {});
        for (const path of Object.values(choices.resourceConflicts ?? {}))
            if (path !== 'keep')
                paths.push(path);
        for (const encoded of bundle.missingCredentials) {
            try {
                const path = JSON.parse(encoded) as string[];
                if (path[0] === 'resources' && path[1] === 'files' && typeof path[2] === 'string')
                    paths.push(path[2]);
            }
            catch { /* A non-resource credential slot does not register any files. */ }
        }
        await this.inspectResources([...new Set(paths)]);
        return this.readRaw();
    }
    saveUi(domain: ConfigDomain, draft: Record<string, unknown>, origin?: {
        base: RawSnapshot;
        sourceId: string;
    }): Promise<void> {
        if (this.disposed)
            throw new ConfigurationError('closed');
        const actual = domain === 'settings' ? this.host.settings : domain === 'workspace' ? this.host.workspaceState : domain === 'safeGuard' ? this.host.safeGuard?.settings : undefined;
        if (!origin && draft !== actual)
            return Promise.reject(new ConfigurationError('draft-base-required'));
        const desired = clone(draft), base = clone(origin?.base ?? this.baseline), sourceId = origin?.sourceId ?? `direct:${domain}`;
        if (draft === actual)
            this.assign(domain, this.baseline[domain]);
        const save = async () => {
            if (domain === 'settings')
                await this.stabilizeCollections(desired);
            const before = await this.service.read();
            const committed = this.baseline[domain], ops: ConfigOperation[] = [];
            for (const d of this.service.describe([domain])) {
                if (canonical(base[domain][d.fieldId]) === canonical(desired[d.fieldId]) || canonical(committed[d.fieldId]) === canonical(desired[d.fieldId]))
                    continue;
                if (canonical(committed[d.fieldId]) !== canonical(base[domain][d.fieldId]) && this.uiLineage.get(sourceId) !== before.revision)
                    throw new ConfigurationError('conflict');
                ops.push({ op: desired[d.fieldId] === undefined ? 'clear' : 'set', moduleId: domain, fieldId: d.fieldId, value: desired[d.fieldId] });
            }
            if (!ops.length) {
                return;
            }
            const preview = await this.service.previewTrusted({ baseRevision: before.revision, operations: ops });
            const result = await this.service.apply({ previewId: preview.id, baseRevision: before.revision, requestId: crypto.randomUUID() });
            this.uiLineage.set(sourceId, result.revision);
        };
        const task = this.uiQueue.then(save);
        this.uiQueue = task.catch(() => { });
        return task;
    }
    createUiFacade<T extends ConfigurationHost>(host: T): T {
        let settings = clone(host.settings), workspace = clone(host.workspaceState);
        const origin = { base: clone(this.baseline), sourceId: crypto.randomUUID() };
        return new Proxy(host, { get: (target, key) => {
                if (key === 'settings')
                    return settings;
                if (key === 'workspaceState')
                    return workspace;
                if (key === 'saveSettings')
                    return async () => { await this.saveUi('settings', settings as unknown as Record<string, unknown>, origin); origin.base = clone(this.baseline); settings = clone(host.settings); };
                if (key === 'saveWorkspaceState')
                    return async () => { await this.saveUi('workspace', workspace as unknown as Record<string, unknown>, origin); origin.base = clone(this.baseline); workspace = clone(host.workspaceState); };
                const value: unknown = Reflect.get(target, key);
                return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }, set: (_target, key, value: unknown) => { if (key === 'settings') {
                settings = value as LlmHubSettings;
                return true;
            } if (key === 'workspaceState') {
                workspace = value as WorkspaceState;
                return true;
            } return Reflect.set(host, key, value); } });
    }
    captureDraft(): {
        base: RawSnapshot;
        sourceId: string;
    } { return { base: clone(this.baseline), sourceId: crypto.randomUUID() }; }
    trackModal<T extends {close():void;onClose():void}>(modal:T):T{if(this.modals.has(modal))return modal;this.modals.add(modal);const close=modal.onClose.bind(modal);modal.onClose=()=>{this.modals.delete(modal);close();};return modal;}
    private async stabilizeCollections(settings: Record<string, unknown>): Promise<void> {
        for (const name of ['mcpServers', 'agentPlugins', 'enabledWorkflowEventTriggers']) {
            const entries = settings[name];
            if (!Array.isArray(entries))
                continue;
            const old = this.baseline?.settings[name] as Record<string, unknown>[] ?? [];
            for (const item of entries as Record<string, unknown>[]) {
                if (item.id)
                    continue;
                const identity = (e: Record<string, unknown>) => canonical(name === 'mcpServers' ? [e.name, e.transport, e.url, e.command] : [e.name, e.repo, e.filePath, e.event]);
                const previous = old.find(e => identity(e) === identity(item));
                item.id = previous?.id ?? `config-${(await digest(identity(item))).slice(0, 24)}`;
            }
        }
    }
    private assign(domain: ConfigDomain, value: Record<string, unknown>): void {
        if (domain === 'settings')
            this.host.settings = clone(value) as unknown as LlmHubSettings;
        if (domain === 'workspace')
            this.host.workspaceState = clone(value) as unknown as WorkspaceState;
        if (domain === 'safeGuard' && this.host.safeGuard)
            this.host.safeGuard.settings = clone(value);
    }
    private async persistDomain(domain: ConfigDomain, value: Record<string, unknown>, phase: 'apply' | 'rollback' = 'apply'): Promise<void> {
        this.assign(domain, value);
        if (domain === 'settings')
            await this.rawSettings();
        if (domain === 'workspace')
            await this.rawWorkspace();
        if (domain === 'safeGuard') {
            if (!this.rawGuard)
                throw new ConfigurationError('guard-unavailable');
            await this.rawGuard();
        }
        if (domain === 'hotkeys') {
            const path = `${this.host.app.vault.configDir}/hotkeys.json`, all = await this.readJson<Record<string, unknown>>(path, {});
            const next = Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith('llmhubpp:')));
            const own = value.bindings as Record<string, unknown> ?? {};
            if (Object.keys(own).some(id => !id.startsWith('llmhubpp:')))
                throw new ConfigurationError('foreign-hotkey');
            await this.host.app.vault.adapter.write(path, JSON.stringify({ ...next, ...own }, null, 2));
            await (this.host.app as unknown as {
                hotkeyManager?: {
                    load(): Promise<void>;
                };
            }).hotkeyManager?.load();
        }
        if (domain === 'resources') {
            const files = value.files as Record<string, string> ?? {};
            for (const [path, text] of Object.entries(files)) {
                this.assertResourcePath(path);
                if (typeof text !== 'string' || text.length > 10 * 1024 * 1024)
                    throw new ConfigurationError('invalid-resource');
                if (phase === 'rollback' && (value.absentPaths as string[] ?? []).includes(path)) {
                    if (await this.host.app.vault.adapter.exists(path)) {
                        await ensureStorageDirectory(this.host.app.vault.adapter, `${this.base}/recovered-resources`);
                        await this.host.app.vault.adapter.rename(path, `${this.base}/recovered-resources/${crypto.randomUUID()}-${path.split('/').pop()}`);
                    }
                    continue;
                }
                await ensureStorageDirectory(this.host.app.vault.adapter, path.split('/').slice(0, -1).join('/'));
                await this.host.app.vault.adapter.write(path, text);
            }
        }
    }
    private async write(domain: ConfigDomain, value: Record<string, unknown>, phase: 'apply' | 'rollback' = 'apply'): Promise<void> {
        try {
            if (domain === 'safeGuard')
                this.guardBefore = clone(this.baseline.safeGuard);
            const normalized = clone(value);
            if (domain === 'workspace')
                for (const [name, rag] of Object.entries(normalized.ragSettings ?? {}))
                    Reflect.set(normalized.ragSettings as object, name, { ...DEFAULT_RAG_SETTING, ...rag as object });
            if (domain === 'settings') {
                normalized.apiProviders = (normalized.apiProviders as Record<string, unknown>[] ?? []).map(p => ({ verified: false, availableModels: [], enabledModels: [], enabled: true, apiKey: '', ...p }));
            }
            await this.persistDomain(domain, normalized, phase);
            this.baseline[domain] = clone(normalized);
            this.assign(domain, normalized);
        }
        catch (error) {
            this.assign(domain, this.baseline[domain]);
            throw error;
        }
    }
    private async validate(before: RawSnapshot, after: RawSnapshot, ops: ConfigOperation[]) {
        const issues = [];
        if (ops.some(op => /workspaceFolder|storageLayout|skillsFolder/.test(op.fieldId)) && this.host.tasks.hasUnfinished())
            issues.push({ code: 'busy', message: '请先结束正在运行的任务，再修改存储目录。' });
        const oldRags = before.workspace.ragSettings as Record<string, Record<string, unknown>> ?? {}, newRags = after.workspace.ragSettings as Record<string, Record<string, unknown>> ?? {};
        const names = new Set<string>();
        for (const [name, rag] of Object.entries(newRags)) {
            const safe = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').toLowerCase();
            if (names.has(safe))
                issues.push({ code: 'index-collision', message: '知识库名称对应相同索引目录。' });
            names.add(safe);
            const old = oldRags[name];
            if (old?.sourceCollection && (!rag.sourceCollection || rag.sourceManifestId !== old.sourceManifestId || rag.externalIndexPath !== old.externalIndexPath))
                issues.push({ code: 'managed-index', message: '不能更改托管索引归属。' });
        }
        for (const [name, rag] of Object.entries(oldRags))
            if (rag.sourceCollection && !newRags[name])
                issues.push({ code: 'managed-index', message: '不能删除托管索引关联。' });
        if (after.resources.files)
            for (const path of Object.keys(after.resources.files as object)) {
                this.assertResourcePath(path);
                if (!Object.prototype.hasOwnProperty.call(before.resources.files ?? {}, path))
                    issues.push({ code: 'resource-not-inspected', message: '请先检查目标资源的现有内容，再预览修改。' });
            }
        const next = getStoragePaths(after.settings as unknown as LlmHubSettings, this.host.app.vault.configDir), old = getStoragePaths(before.settings as unknown as LlmHubSettings, this.host.app.vault.configDir);
        if (next.state !== old.state && await this.host.app.vault.adapter.exists(`${next.state}/gemini-workspace.json`))
            issues.push({ code: 'target-exists', message: '目标状态目录已含配置，请先处理路径冲突。' });
        return issues;
    }
    assertResourcePath(path: string): void {
        const storage = getStoragePaths(this.host.settings, this.host.app.vault.configDir);
        if (path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || !(/\.(?:md|json|ya?ml|ps1|py|js|mjs|cjs|sh|txt)$/i.test(path)) || ![storage.tools, storage.skills, `${storage.workspace}/workflows`].some(root => path.startsWith(root + '/')))
            throw new ConfigurationError('resource-out-of-scope');
    }
    private async saveJournal(value: ConfigurationJournal | null, before?: RawSnapshot): Promise<void> {
        if (value && before && this.host.app.secretStorage) {
            if (!writeSecretJson(this.host.app, 'llmhubpp-config-recovery', before))
                throw new ConfigurationError('recovery-storage-failed');
        }
        await this.writeJson('pending.json', value);
        if (!value)
            clearSecret(this.host.app, 'llmhubpp-config-recovery');
    }
    private async loadJournal(): Promise<ConfigurationJournal | null> {
        const journal = await this.readJson<ConfigurationJournal | null>(`${this.base}/pending.json`, null);
        if (!journal)
            return null;
        const snapshot = readSecretJson<RawSnapshot>(this.host.app, 'llmhubpp-config-recovery');
        if (snapshot) {
            for (const domain of journal.domains)
                await this.write(domain, snapshot[domain], 'rollback');
            await this.writeJson('pending.json', null);
            clearSecret(this.host.app, 'llmhubpp-config-recovery');
            return null;
        }
        // Never replace a secret with an omitted/redacted placeholder after an interrupted commit.
        if (!journal.hasSecrets) {
            for (const domain of journal.domains)
                await this.write(domain, restoreConfigurationValue(journal.before[domain], this.baseline[domain]) as Record<string, unknown>, 'rollback');
            await this.writeJson('pending.json', null);
            return null;
        }
        return journal;
    }
    async dispose(): Promise<void> { this.disposed = true;for(const modal of [...this.modals])modal.close();this.modals.clear(); this.service.beginShutdown(); await this.mcp.dispose(); await this.uiQueue; await this.service.drain(); this.host.saveSettings = this.originalSave; this.host.saveWorkspaceState = this.originalWorkspace; this.host.setWorkspaceConfigurationSaver?.(this.rawWorkspace); if (this.host.safeGuard && this.rawGuard)
        this.host.safeGuard.saveSettings = this.rawGuard; }
    async exportRaw(): Promise<RawSnapshot> { return this.readRaw(); }
    async history(): Promise<ConfigHistoryEntry[]> { return this.service.history(); }
    async ordinarySnapshot(): Promise<RawSnapshot> { return redact(await this.readRaw(), '', 'omit') as RawSnapshot; }
    async mergeForImport(domain: ConfigDomain, value: Record<string, unknown>): Promise<Record<string, unknown>> { return mergeObject(this.baseline[domain], value) as Record<string, unknown>; }
}
