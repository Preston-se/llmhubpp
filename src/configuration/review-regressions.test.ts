import { describe, it, expect } from 'vitest';
import { ConfigurationService } from './service';
import { createRegistry } from './registry';
import { DEFAULT_SETTINGS, DEFAULT_WORKSPACE_STATE } from '../types';
import { exportConfigurationBundle, inspectConfigurationBundle } from './bundle/codec';
import { previewConfigurationImport } from './bundle/import';
import { createStorageLayout } from '../core/storagePaths';
function fixture() { let raw: any = { settings: { ...structuredClone(DEFAULT_SETTINGS), maxSavedChatHistories: 0 }, workspace: structuredClone(DEFAULT_WORKSPACE_STATE), safeGuard: {}, hotkeys: {}, resources: { files: {} } }; const service = new ConfigurationService(createRegistry({ settings: DEFAULT_SETTINGS as any }), { read: async () => structuredClone(raw), write: async (d, v) => { raw[d] = v; }, activate: async () => ({ reloadRequired: false }), journal: async () => { }, loadJournal: async () => null }); return { service, get raw() { return raw; } }; }
describe('independent review regressions', () => {
    it('imports legacy storage overrides and preserves existing reading menu preferences', async () => {
        const source = fixture(), target = fixture();
        source.raw.settings.storageLayout = createStorageLayout({ workspaceFolder: 'LLMHub', skillsFolder: 'MySkills' }, '.obsidian');
        source.raw.settings.readingMenus = { contexts: { editor: true, epub: false } };
        target.raw.settings.readingMenus = { contexts: { file: false } };
        const bundle = await inspectConfigurationBundle(await exportConfigurationBundle(source.raw, { version: '0.36.7' }));
        const preview = await previewConfigurationImport(target.service, target.raw, bundle);
        await target.service.apply({ previewId: preview.id, baseRevision: preview.baseRevision, requestId: 'legacy-maps' });
        expect(target.raw.settings.storageLayout).toEqual(source.raw.settings.storageLayout);
        expect(target.raw.settings.readingMenus.contexts).toEqual({ editor: true, epub: false, file: false });
    });
    it('supports ordinary new-vault import with new provider entities and legacy unlimited history', async () => {
        const target = fixture(), source = fixture();
        source.raw.settings.apiProviders = [{ id: 'p', name: 'P', type: 'custom', baseUrl: 'https://example.test', apiKey: 'SECRET', enabledModels: ['m'], availableModels: ['m'], verified: true, enabled: true }];
        const bundle = await inspectConfigurationBundle(await exportConfigurationBundle(source.raw, { version: '0.36.7' }));
        const p = await previewConfigurationImport(target.service, target.raw, bundle);
        await target.service.apply({ previewId: p.id, baseRevision: p.baseRevision, requestId: 'new-vault' });
        expect(target.raw.settings.apiProviders[0].name).toBe('P');
        expect(target.raw.settings.maxSavedChatHistories).toBe(0);
    });
    it('clears a nested credential to the leaf default and never writes the root array as its value', async () => {
        const f = fixture();
        f.raw.settings.maxSavedChatHistories = 100;
        f.raw.settings.apiProviders = [{ id: 'p', name: 'P', type: 'custom', baseUrl: 'https://example.test', apiKey: 'SECRET', enabledModels: [], availableModels: [], verified: false, enabled: true }];
        const s = await f.service.read(), p = await f.service.preview({ baseRevision: s.revision, operations: [{ op: 'clear', moduleId: 'settings', fieldId: 'apiProviders.apiKey', entityId: 'p' }] });
        await f.service.apply({ previewId: p.id, baseRevision: s.revision, requestId: 'clear' });
        expect(f.raw.settings.apiProviders[0].apiKey ?? '').toBe('');
        expect(Array.isArray(f.raw.settings.apiProviders[0].apiKey)).toBe(false);
    });
    it('requires encryption for selected resource text containing credentials', async () => {
        const f = fixture();
        f.raw.resources.files = { 'LLMHub/tools/options.json': '{"apiKey":"RESOURCE-SECRET"}' };
        await expect(exportConfigurationBundle(f.raw, { version: '0.36.7', includeResources: true, resourcePaths: ['LLMHub/tools/options.json'] })).rejects.toMatchObject({ code: 'resource-encryption-required' });
    });
});
