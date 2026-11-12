import { describe, it, expect } from 'vitest';
import { HostConfiguration } from './host';
import { DEFAULT_SETTINGS, DEFAULT_WORKSPACE_STATE } from '../types';
import { previewConfigurationImport } from './bundle/import';
import { applySettingsCredentials, mcpCredentialKey } from '../core/credentialBundle';
function fixture() { const files = new Map<string, string>(); let fail = ''; const events: string[] = []; const host: any = { manifest: { dir: 'plugins/llmhubpp' }, app: { vault: { configDir: 'config', adapter: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p), mkdir: async () => { }, rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); }, write: async (p: string, s: string) => { if (fail === p) {
                    fail = '';
                    throw Error('disk');
                } files.set(p, s); } } } }, settings: structuredClone(DEFAULT_SETTINGS), workspaceState: structuredClone(DEFAULT_WORKSPACE_STATE), saveSettings: async () => { files.set('plugins/llmhubpp/data.json', JSON.stringify(host.settings)); }, saveWorkspaceState: async () => { files.set('workspace/state.json', JSON.stringify(host.workspaceState)); }, getWorkspaceStateFilePath: () => 'workspace/state.json', tasks: { hasUnfinished: () => false }, settingsEmitter: { emit: (s: string) => events.push(s) } }; return { host, files, events, fail: (path: string) => { fail = path; } }; }
describe('host review regressions', () => {
    it('remembers an MCP tool after restoring a stdio credential with no HTTP headers', async () => {
        const f = fixture();
        const server = { id: 'search', name: 'Search', transport: 'stdio' as const, command: 'node', enabled: true };
        f.host.settings.mcpServers = [server];
        applySettingsCredentials(f.host.settings, { mcpCredentials: { [mcpCredentialKey(server)]: { env: { SEARCH_KEY: 'test' } } } });
        const configuration = new HostConfiguration(f.host);
        await configuration.initialize();
        const saved = f.host.settings.mcpServers[0];
        expect(Object.prototype.hasOwnProperty.call(saved, 'headers')).toBe(true);
        expect(saved.headers).toBeUndefined();
        saved.allowedTools = ['search_web'];

        await f.host.saveSettings();

        expect(f.host.settings.mcpServers[0]).toMatchObject({ allowedTools: ['search_web'], env: { SEARCH_KEY: 'test' } });
        expect(JSON.parse(f.files.get('plugins/llmhubpp/data.json')!).mcpServers[0].allowedTools).toEqual(['search_web']);
        const settings = configuration.createUiFacade(f.host);
        settings.settings.mcpServers[0].allowedTools = [];
        await settings.saveSettings();
        expect(f.host.settings.mcpServers[0].allowedTools).toEqual([]);
        await configuration.dispose();
    });
    it('retains tool approvals for the same connection and removes them when launch arguments change', async () => {
        const f = fixture();
        f.host.settings.mcpServers = [{ id: 'search', name: 'Search', transport: 'stdio', command: 'node',
            args: ['search.mjs'], enabled: true, allowedTools: ['search_web'] }];
        const configuration = new HostConfiguration(f.host);
        await configuration.initialize();

        f.host.settings.mcpServers[0].name = 'Web search';
        await f.host.saveSettings();
        expect(f.host.settings.mcpServers[0].allowedTools).toEqual(['search_web']);

        f.host.settings.mcpServers[0].args = ['different.mjs'];
        await f.host.saveSettings();
        expect(f.host.settings.mcpServers[0]).toMatchObject({ args: ['different.mjs'], allowedTools: [] });
        await configuration.dispose();
    });
    it('imports a conflicting resource to a new inspected path without overwriting the original', async () => { const f = fixture(), c = new HostConfiguration(f.host); await c.initialize(); const old = 'LLMHub/tools/user.md', copy = 'LLMHub/tools/user-copy.md'; f.files.set(old, 'my edit'); const bundle: any = { snapshot: { resources: { files: { [old]: 'package version' } } }, missingCredentials: [], manifest: { modules: ['resources'] } }; const choices = { modules: ['resources'], resourceConflicts: { [old]: copy } }; const p = await previewConfigurationImport(c.service, await c.prepareImport(bundle, choices), bundle, choices); await c.service.apply({ previewId: p.id, baseRevision: p.baseRevision, requestId: 'copy' }); expect(f.files.get(old)).toBe('my edit'); expect(f.files.get(copy)).toBe('package version'); await c.dispose(); });
    it('persists runtime-managed context memory without exposing it to the configuration Agent', async () => { const f = fixture(); let persisted = ''; f.host.safeGuard = { settings: { contextMemories: {} }, saveSettings: async () => { persisted = JSON.stringify(f.host.safeGuard.settings); } }; const c = new HostConfiguration(f.host); await c.initialize(); f.host.safeGuard.settings.contextMemories = { chat: { text: 'PRIVATE-CHAT' } }; await f.host.safeGuard.saveSettings(); expect(persisted).toContain('PRIVATE-CHAT'); expect(JSON.stringify(await c.service.read())).not.toContain('PRIVATE-CHAT'); expect(JSON.stringify(await c.service.history())).not.toContain('PRIVATE-CHAT'); await c.dispose(); });
    it('keeps a UI draft independent, merges unrelated fields and rejects conflicting ones', async () => {
        const f = fixture(), c = new HostConfiguration(f.host);
        await c.initialize();
        const ui = c.createUiFacade(f.host);
        const s = await c.service.read(), p = await c.service.preview({ baseRevision: s.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 27 }] });
        await c.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'agent' });
        ui.settings.maxNoteChars = 26000;
        await ui.saveSettings();
        expect(f.host.settings.maxFunctionCalls).toBe(27);
        expect(f.host.settings.maxNoteChars).toBe(26000);
        const old = c.createUiFacade(f.host);
        const q = await c.service.preview({ baseRevision: (await c.service.read()).revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 28 }] });
        await c.service.apply({ previewId: q.id, baseRevision: q.baseRevision, requestId: 'agent2' });
        old.settings.maxFunctionCalls = 29;
        await expect(old.saveSettings()).rejects.toMatchObject({ code: 'conflict' });
        expect(old.settings.maxFunctionCalls).toBe(29);
        expect(f.host.settings.maxFunctionCalls).toBe(28);
        await c.dispose();
    });
    it('reloads persisted redacted history without pretending session restore snapshots survived', async () => { const f = fixture(), c = new HostConfiguration(f.host); await c.initialize(); f.host.settings.maxFunctionCalls = 23; await f.host.saveSettings(); await c.dispose(); const next = new HostConfiguration(f.host); await next.initialize(); const entries = await next.service.history(); expect(entries).toHaveLength(1); await expect(next.service.restore({ operationId: entries[0].operationId, baseRevision: (await next.service.read()).revision, requestId: 'restore' })).rejects.toMatchObject({ code: 'restore-unavailable' }); await next.dispose(); });
    it('serializes rapid UI saves without splitting runtime, disk and committed values', async () => { const f = fixture(), c = new HostConfiguration(f.host); await c.initialize(); f.host.settings.maxFunctionCalls = 21; const first = f.host.saveSettings(); f.host.settings.maxFunctionCalls = 22; const second = f.host.saveSettings(); await Promise.all([first, second]); expect(f.host.settings.maxFunctionCalls).toBe(22); expect((await c.service.read()).modules.settings.maxFunctionCalls).toBe(22); expect(JSON.parse(f.files.get('plugins/llmhubpp/data.json')!).maxFunctionCalls).toBe(22); await c.dispose(); });
    it('requires a base for detached drafts and never restores stale runtime objects after a conflict', async () => { const f = fixture(), c = new HostConfiguration(f.host); await c.initialize(); const draft = structuredClone(f.host.settings), s = await c.service.read(), p = await c.service.preview({ baseRevision: s.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 27 }] }); await c.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'agent' }); draft.maxNoteChars = 25000; await expect(c.saveUi('settings', draft)).rejects.toMatchObject({ code: 'draft-base-required' }); expect(f.host.settings.maxFunctionCalls).toBe(27); await c.dispose(); });
    it('detects externally edited resources and restores every overwritten file on partial failure', async () => {
        const f = fixture(), c = new HostConfiguration(f.host);
        await c.initialize();
        const a = 'LLMHub/tools/a.md', b = 'LLMHub/tools/b.md';
        f.files.set(a, 'old A');
        f.files.set(b, 'old B');
        await c.inspectResources([a, b]);
        let s = await c.service.read();
        let p = await c.service.preview({ baseRevision: s.revision, operations: [{ op: 'set', moduleId: 'resources', fieldId: 'files', value: { [a]: 'new A', [b]: 'new B' } }] });
        f.files.set(a, 'external edit');
        await expect(c.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'stale' })).rejects.toMatchObject({ code: 'conflict' });
        await c.inspectResources([a, b]);
        s = await c.service.read();
        p = await c.service.preview({ baseRevision: s.revision, operations: [{ op: 'set', moduleId: 'resources', fieldId: 'files', value: { [a]: 'new A', [b]: 'new B' } }] });
        f.fail(b);
        await expect(c.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'partial' })).rejects.toMatchObject({ code: 'save-failed' });
        expect(f.files.get(a)).toBe('external edit');
        expect(f.files.get(b)).toBe('old B');
        await c.dispose();
    });
    it('emits workspace selection events when the Agent changes the active knowledge base', async () => { const f = fixture(), c = new HostConfiguration(f.host); await c.initialize(); const s = await c.service.read(), p = await c.service.preview({ baseRevision: s.revision, operations: [{ op: 'set', moduleId: 'workspace', fieldId: 'webSearchEnabled', value: true }] }); await c.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'select' }); expect(f.events).toContain('workspace-state-loaded'); expect(f.events).toContain('search-selection-changed'); await c.dispose(); });
});
