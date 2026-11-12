import { describe, it, expect } from 'vitest';
import { HostConfiguration } from './host';
import { DEFAULT_SETTINGS, DEFAULT_WORKSPACE_STATE } from '../types';
describe('host configuration integration', () => {
    it('assigns stable collection ids without replacing user settings or writing on initialization', async () => {
        const host: any = { manifest: { dir: 'plugins/llmhubpp' }, app: { vault: { configDir: 'config', adapter: { exists: async () => false, mkdir: async () => { }, write: async () => { throw Error('unexpected write'); } } } }, settings: { ...structuredClone(DEFAULT_SETTINGS), mcpServers: [{ name: 'Tools', transport: 'http', url: 'http://127.0.0.1:5000' }] }, workspaceState: structuredClone(DEFAULT_WORKSPACE_STATE), saveSettings: async () => { }, saveWorkspaceState: async () => { }, getWorkspaceStateFilePath: () => 'state.json', tasks: { hasUnfinished: () => false }, settingsEmitter: { emit: () => { } } };
        const config = new HostConfiguration(host);
        await config.initialize();
        const a = await config.exportRaw(), b = await config.exportRaw();
        expect((a.settings.mcpServers as any[])[0].id).toBeTruthy();
        expect((a.settings.mcpServers as any[])[0].id).toBe((b.settings.mcpServers as any[])[0].id);
        expect(host.settings.mcpServers[0].name).toBe('Tools');
        await config.dispose();
    });
    it('routes an existing UI save through preview/apply and persists equivalent Agent changes', async () => {
        const files = new Map<string, string>();
        let saves = 0;
        const host: any = { manifest: { dir: 'plugins/llmhubpp' }, app: { vault: { configDir: 'config', adapter: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p), write: async (p: string, s: string) => { files.set(p, s); }, mkdir: async () => { } } } }, settings: structuredClone(DEFAULT_SETTINGS), workspaceState: structuredClone(DEFAULT_WORKSPACE_STATE), saveSettings: async () => { saves++; files.set('plugins/llmhubpp/data.json', JSON.stringify(host.settings)); }, saveWorkspaceState: async () => { }, getWorkspaceStateFilePath: () => 'workspace/state.json', tasks: { hasUnfinished: () => false }, settingsEmitter: { emit: () => { } } };
        const config = new HostConfiguration(host);
        await config.initialize();
        host.settings.maxFunctionCalls = 30;
        await host.saveSettings();
        expect(saves).toBe(1);
        expect((await config.service.read()).modules.settings.maxFunctionCalls).toBe(30);
        const before = await config.service.read();
        const p = await config.service.preview({ baseRevision: before.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 31 }] });
        await config.service.apply({ previewId: p.id, baseRevision: before.revision, requestId: 'agent' });
        expect(host.settings.maxFunctionCalls).toBe(31);
        expect(saves).toBe(2);
        await config.dispose();
    });
});
