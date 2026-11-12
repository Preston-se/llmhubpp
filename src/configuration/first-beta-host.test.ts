import { expect, it } from 'vitest';
import { HostConfiguration } from './host';
import { DEFAULT_SETTINGS, DEFAULT_WORKSPACE_STATE } from '../types';
import { previewConfigurationImport } from './bundle/import';
import { exportConfigurationBundle, inspectConfigurationBundle } from './bundle/codec';

function fixture() {
    const files = new Map<string, string>();
    const host: any = {
        manifest: { dir: 'plugins/llmhubpp', version: 'test' },
        app: { vault: { configDir: 'config', adapter: {
            exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p),
            mkdir: async () => {}, write: async (p: string, text: string) => { files.set(p, text); },
        } } },
        settings: { ...structuredClone(DEFAULT_SETTINGS), apiProviders: [{ id: 'a', name: 'Original', type: 'custom', baseUrl: 'https://example.test', apiKey: 'DEVICE-SECRET', enabled: true, verified: false, enabledModels: [], availableModels: [] }] },
        workspaceState: structuredClone(DEFAULT_WORKSPACE_STATE),
        saveSettings: async () => { files.set('plugins/llmhubpp/data.json', JSON.stringify(host.settings)); },
        saveWorkspaceState: async () => {}, getWorkspaceStateFilePath: () => 'workspace/state.json',
        tasks: { hasUnfinished: () => false }, settingsEmitter: { emit: () => {} },
    };
    return { host, files };
}
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

it('includes a UI save completed during encrypted-resource inspection in the merge baseline', async () => {
    const f = fixture(), c = new HostConfiguration(f.host);
    await c.initialize();
    const path = 'LLMHub/tools/example.md';
    f.files.set(path, 'current synthetic text');
    const source = await c.exportRaw();
    source.settings = { apiProviders: [{ id: 'a', enabledModels: ['m'] }] };
    source.resources.files = { [path]: 'package synthetic text' };
    const bundle = await inspectConfigurationBundle(await exportConfigurationBundle(source, { version: 'test', password: 'synthetic-password', includeResources: true, resourcePaths: [path] }));
    const entered = gate(), release = gate(), adapter = f.host.app.vault.adapter, read = adapter.read;
    let intercepted = false;
    adapter.read = async (p: string) => {
        if (p === path && !intercepted) { intercepted = true; entered.resolve(); await release.promise; }
        return read(p);
    };
    const choices = { password: 'synthetic-password', resourceConflicts: { [path]: 'keep' } };
    const preparation = c.prepareImport(bundle, choices);
    try {
        await entered.promise;
        f.host.settings.apiProviders[0].name = 'Concurrent UI name';
        await f.host.saveSettings();
        release.resolve();
        const p = await previewConfigurationImport(c.service, await preparation, bundle, choices);
        await c.service.apply({ previewId: p.id, baseRevision: p.baseRevision, requestId: 'inspected-merge' });
        expect(f.host.settings.apiProviders[0]).toMatchObject({ name: 'Concurrent UI name', enabledModels: ['m'], apiKey: 'DEVICE-SECRET' });
        expect(f.files.get(path)).toBe('current synthetic text');
    } finally { release.resolve(); await preparation; await c.dispose(); }
});

it('rejects an encrypted resource import if an inspected file changes during decryption', async () => {
    const f = fixture(), c = new HostConfiguration(f.host);
    await c.initialize();
    const path = 'LLMHub/tools/example.md';
    const source = await c.exportRaw();
    source.settings.maxFunctionCalls = 27;
    source.resources.files = { [path]: 'package synthetic text' };
    const bundle = await inspectConfigurationBundle(await exportConfigurationBundle(source, { version: 'test', password: 'synthetic-password', includeResources: true, resourcePaths: [path] }));
    const choices = { password: 'synthetic-password' };
    const current = await c.prepareImport(bundle, choices);
    const pending = previewConfigurationImport(c.service, current, bundle, choices);
    f.files.set(path, 'concurrent synthetic text');
    try {
        await expect(pending).rejects.toMatchObject({ code: 'conflict' });
        expect(f.files.get(path)).toBe('concurrent synthetic text');
        expect(f.host.settings.maxFunctionCalls).toBe(20);
    } finally { await c.dispose(); }
});

it('returns actionable encrypted-import and resource-export failures through the actual host MCP', async () => {
    const f = fixture(), c = new HostConfiguration(f.host);
    await c.initialize();
    const connection = await c.mcp.start();
    const call = async (name: string, args: object) => {
        const res = await fetch(connection.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
        return (await res.json()).result;
    };
    try {
        const ordinary = await call('configuration_export', {});
        expect(ordinary).toMatchObject({ structuredContent: { ok: true, handle: expect.any(String) } });
        const resources = await call('configuration_export', { includeResources: true });
        expect(resources).toMatchObject({ isError: true, structuredContent: { code: 'LOCAL_RESOURCE_EXPORT_REQUIRED', hint: expect.stringMatching(/本地.*口令|口令.*导出/) } });
        const bytes = await exportConfigurationBundle(await c.exportRaw(), { version: 'test', password: 'synthetic-password' });
        const upload = await fetch(connection.endpoint.replace('/mcp', '/configuration-bundles'), { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token }, body: new Uint8Array(bytes) });
        const { uploadHandle } = await upload.json();
        const locked = await call('configuration_import_preview', { uploadHandle });
        expect(locked).toMatchObject({ isError: true, structuredContent: { code: 'LOCAL_PASSWORD_REQUIRED', hint: expect.stringMatching(/本地/) } });
        expect(f.files.has('plugins/llmhubpp/data.json')).toBe(false);
    } finally { await c.dispose(); }
});
