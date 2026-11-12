import { describe, it, expect } from 'vitest';
import { ConfigurationService } from './service';
import { createRegistry } from './registry';
import type { ConfigurationBackend, RawSnapshot } from './types';
function fixture() {
    let data: RawSnapshot = { settings: { maxFunctionCalls: 20, apiProviders: [{ id: 'a', name: 'A', type: 'custom', baseUrl: 'https://example.test', apiKey: 'PRIVATE-KEY', enabledModels: [], availableModels: [], verified: false, enabled: true }] }, workspace: { ragSettings: { Study: { topK: 6, chunkSize: 500, chunkOverlap: 100 } } }, safeGuard: { listenHost: '127.0.0.1', listenPort: 11435 }, hotkeys: {}, resources: {} };
    const writes: string[] = [];
    let fail = '';
    let journal: unknown = null;
    const backend: ConfigurationBackend = { read: async () => structuredClone(data), write: async (domain, value) => { writes.push(domain); if (fail === domain)
            throw Error('PRIVATE-KEY'); data[domain] = structuredClone(value); }, activate: async () => ({ reloadRequired: false }), journal: async (value) => { journal = value; }, loadJournal: async () => null };
    const service = new ConfigurationService(createRegistry(), backend);
    return { service, writes, backend, get data() { return data; }, setFail: (s: string) => { fail = s; }, get journal() { return journal; } };
}
describe('configuration service', () => {
    it.each([
        ['readingMenus', 'contexts', { editor: true }, { editor: 'true' }],
        ['storageLayout', 'overrides', { state: 'LLMHub' }, { state: true }],
    ] as const)('previews optional finite keys in %s with their declared types', async (fieldId, property, valid, wrongType) => {
        const f = fixture();
        f.data.settings.storageLayout = { version: 1, root: 'LLMHub', overrides: {} };
        const { revision } = await f.service.read();
        const preview = (map: unknown) => f.service.preview({ baseRevision: revision, operations: [
            { op: 'update', moduleId: 'settings', fieldId, value: { [property]: map } },
        ] });
        await expect(preview({ ...valid, typo: true })).rejects.toMatchObject({ code: 'invalid' });
        await expect(preview(wrongType)).rejects.toMatchObject({ code: 'invalid' });
        const change = await preview(valid);
        expect(f.writes).toEqual([]);
        await f.service.apply({ previewId: change.id, baseRevision: revision, requestId: fieldId });
        expect(f.data.settings[fieldId]).toMatchObject({ [property]: valid });
    });
    it('never permits a forged readonly field on a later entity in the same collection', async () => {
        const f = fixture();
        const a = (f.data.settings.apiProviders as any[])[0];
        f.data.settings.apiProviders = [a, { ...a, id: 'b' }];
        const snap = await f.service.read();
        await expect(f.service.preview({ baseRevision: snap.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'apiProviders', value: [a, { ...a, id: 'b', verified: true }] }] })).rejects.toMatchObject({ code: 'readonly' });
    });
    it('expires previews and restores previous ordinary configuration', async () => {
        const f = fixture();
        const s = await f.service.read();
        const p = await f.service.preview({ baseRevision: s.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 27 }] });
        const applied = await f.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'first' });
        const restored = await f.service.restore({ operationId: applied.operationId, baseRevision: applied.revision, requestId: 'restore' });
        expect(restored.status).toBe('applied');
        expect(f.data.settings.maxFunctionCalls).toBe(20);
    });
    it('blocks writes but remains readable when a pending journal needs manual recovery', async () => {
        const f = fixture();
        f.backend.loadJournal = async () => ({ id: 'interrupted', before: f.data, after: f.data, domains: ['settings'], state: 'pending', hasSecrets: true });
        await expect(f.service.recover()).resolves.toBeUndefined();
        expect((await f.service.read()).revision).toBeTruthy();
        const s = await f.service.read(), p = await f.service.preview({ baseRevision: s.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 25 }] });
        await expect(f.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'blocked' })).rejects.toMatchObject({ code: 'recovery-required' });
    });
    it('previews without saving and hides credentials', async () => {
        const f = fixture();
        const snap = await f.service.read();
        expect(JSON.stringify(snap)).not.toContain('PRIVATE-KEY');
        const p = await f.service.preview({ baseRevision: snap.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 25 }] });
        expect(p.changes).toHaveLength(1);
        expect(f.writes).toEqual([]);
        expect(f.data.settings.maxFunctionCalls).toBe(20);
        const result = await f.service.apply({ previewId: p.id, baseRevision: snap.revision, requestId: 'one' });
        expect(result.status).toBe('applied');
        expect(f.data.settings.maxFunctionCalls).toBe(25);
        expect(await f.service.apply({ previewId: p.id, baseRevision: snap.revision, requestId: 'one' })).toEqual(result);
        expect(f.writes).toEqual(['settings']);
    });
    it('rejects stale previews and malformed or privileged fields', async () => {
        const f = fixture();
        const snap = await f.service.read();
        const p = await f.service.preview({ baseRevision: snap.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 22 }] });
        f.data.settings.maxFunctionCalls = 23;
        await expect(f.service.apply({ previewId: p.id, baseRevision: snap.revision, requestId: 'stale' })).rejects.toMatchObject({ code: 'conflict' });
        for (const [fieldId, value] of [['__proto__', {}], ['maxFunctionCalls', 'bad'], ['apiProviders.verified', true], ['missing', 1]] as const) {
            await expect(f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [{ op: 'set', moduleId: 'settings', fieldId, value, entityId: fieldId.includes('apiProviders') ? 'a' : undefined }] })).rejects.toBeDefined();
        }
        expect(f.writes).toEqual([]);
    });
    it('updates an entity field with its stable id and enforces RAG constraints', async () => {
        const f = fixture();
        const snap = await f.service.read();
        const p = await f.service.preview({ baseRevision: snap.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'apiProviders.name', entityId: 'a', value: 'Renamed' }] });
        await f.service.apply({ previewId: p.id, baseRevision: snap.revision, requestId: 'rename' });
        expect((f.data.settings.apiProviders as Array<Record<string, unknown>>)[0].apiKey).toBe('PRIVATE-KEY');
        await expect(f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [{ op: 'set', moduleId: 'workspace', fieldId: 'ragSettings.chunkOverlap', entityId: 'Study', value: 501 }] })).rejects.toMatchObject({ code: 'invalid' });
    });
    it('rolls back on persistence failure without leaking secrets into the journal', async () => {
        const f = fixture();
        const snap = await f.service.read();
        const p = await f.service.preview({ baseRevision: snap.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 25 }, { op: 'set', moduleId: 'safeGuard', fieldId: 'listenPort', value: 11436 }] });
        f.setFail('safeGuard');
        await expect(f.service.apply({ previewId: p.id, baseRevision: snap.revision, requestId: 'fail' })).rejects.toMatchObject({ code: 'recovery-required' });
        expect(f.data.settings.maxFunctionCalls).toBe(20);
        expect(JSON.stringify(f.journal)).not.toContain('PRIVATE-KEY');
    });
});
it("rejects moving an embedding endpoint while the old credential would be inherited", async () => {
    const f = fixture();
    const rags = f.data.workspace.ragSettings as Record<string, Record<string, unknown>>;
    rags.Study = { ...rags.Study, embeddingBaseUrl: "https://original.invalid", embeddingApiKey: "SYNTHETIC-KEY" };
    const { revision } = await f.service.read();
    await expect(f.service.preview({ baseRevision: revision, operations: [{
        op: "update", moduleId: "workspace", fieldId: "ragSettings", entityId: "Study", value: { embeddingBaseUrl: "https://replacement.invalid" },
    }] })).rejects.toMatchObject({ code: "embedding-credential-rebind-required" });
    expect(f.writes).toHaveLength(0);
});
