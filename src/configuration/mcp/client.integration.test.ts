import { it, expect, vi } from 'vitest';
vi.mock('obsidian', async () => ({ ...await vi.importActual<object>('obsidian'), requestUrl: async (options: any) => { const r = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body }); const text = await r.text(); if (options.throw !== false && !r.ok)
        throw Object.assign(Error('HTTP ' + r.status), { status: r.status }); return { status: r.status, headers: Object.fromEntries(r.headers), text, json: text ? JSON.parse(text) : undefined }; } }));
import { McpHttpClient } from 'obsidian-llm-hub-common/mcp';
import { ConfigurationMcpServer } from './server';
import { ConfigurationService } from '../service';
import { createRegistry } from '../registry';
it('interoperates with the shipped real MCP client over local HTTP and reads guide resources', async () => {
    let raw: any = { settings: { maxFunctionCalls: 20 }, workspace: {}, safeGuard: {}, hotkeys: {}, resources: {} };
    const service = new ConfigurationService(createRegistry(), { read: async () => structuredClone(raw), write: async (d, v) => { raw[d] = v; }, activate: async () => ({ reloadRequired: false }), journal: async () => { }, loadJournal: async () => null });
    const server = new ConfigurationMcpServer(service), connection = await server.start();
    const client = new McpHttpClient({ name: 'configuration', transport: 'http', url: connection.endpoint, headers: { Authorization: `Bearer ${connection.token}` }, enabled: true });
    try {
        const init = await client.initialize();
        expect(init.protocolVersion).toBe('2025-11-25');
        const tools = await client.listTools();
        expect(tools.some(t => t.name === 'configuration_apply')).toBe(true);
        const read = await client.callToolRaw('configuration_read', {}, true);
        expect(read.isError).not.toBe(true);
        expect(JSON.stringify(read)).toContain('maxFunctionCalls');
        const guide = await client.readResource('llmhubpp://configuration/guide');
        expect(guide?.text).toContain('configuration_preview');
    }
    finally {
        await client.close();
        await server.stop();
    }
});
