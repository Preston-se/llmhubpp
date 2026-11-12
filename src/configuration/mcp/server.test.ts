import { describe, it, expect } from 'vitest';
import { ConfigurationMcpServer } from './server';
import { ConfigurationService } from '../service';
import { createRegistry } from '../registry';
describe('configuration MCP HTTP', () => {
    it('authenticates, negotiates and exposes executable configuration tools only while enabled', async () => {
        const raw: any = { settings: { maxFunctionCalls: 20 }, workspace: {}, safeGuard: {}, hotkeys: {}, resources: {} };
        const service = new ConfigurationService(createRegistry(), { read: async () => structuredClone(raw), write: async (d, v) => { raw[d] = v; }, activate: async () => ({ reloadRequired: false }), journal: async () => { }, loadJournal: async () => null });
        const server = new ConfigurationMcpServer(service);
        expect(server.getStatus().state).toBe('closed');
        const connection = await server.start();
        const call = async (method: string, params: unknown = {}, token = connection.token, extra: Record<string, string> = {}) => fetch(connection.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        try {
            expect((await call('initialize', {}, 'wrong')).status).toBe(401);
            expect((await call('initialize', {}, connection.token, { Origin: 'https://evil.test' })).status).toBe(403);
            const init = await (await call('initialize', { protocolVersion: '2025-11-25' })).json();
            expect(init.result.capabilities.tools).toBeDefined();
            const list = await (await call('tools/list')).json();
            expect(list.result.tools.map((t: any) => t.name)).toContain('configuration_apply');
            const read = await (await call('tools/call', { name: 'configuration_read', arguments: {} })).json();
            expect(read.result.structuredContent.modules.settings.maxFunctionCalls).toBe(20);
            const revision = read.result.structuredContent.revision;
            const operations = [
                { op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 28 },
                { op: 'set', moduleId: 'settings', fieldId: 'readingMenus', value: { contexts: { editor: true } } },
                { op: 'set', moduleId: 'settings', fieldId: 'storageLayout', value: { version: 1, root: 'LLMHub', overrides: { state: 'LLMHub' } } },
            ];
            const preview = await (await call('tools/call', { name: 'configuration_preview', arguments: { baseRevision: revision, operations } })).json();
            const applied = await (await call('tools/call', { name: 'configuration_apply', arguments: { previewId: preview.result.structuredContent.id, baseRevision: revision, requestId: 'http' } })).json();
            expect(applied.result.structuredContent.status).toBe('reload-required');
            expect(raw.settings.maxFunctionCalls).toBe(28);
            expect(raw.settings.readingMenus.contexts).toEqual({ editor: true });
            expect(raw.settings.storageLayout.overrides).toEqual({ state: 'LLMHub' });
            expect((await call('tools/call', { name: 'run_shell', arguments: {} })).status).toBe(200);
            await server.rotateToken();
            expect((await call('tools/list')).status).toBe(401);
        }
        finally {
            await server.stop();
        }
        expect(server.getStatus().state).toBe('closed');
        await expect(fetch(connection.endpoint)).rejects.toThrow();
        await server.dispose();
        await expect(server.start()).rejects.toMatchObject({code:'closed'});
    });
});
