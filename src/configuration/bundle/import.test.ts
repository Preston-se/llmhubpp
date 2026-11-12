import { describe, it, expect } from 'vitest';
import { ConfigurationService } from '../service';
import { createRegistry } from '../registry';
import { previewConfigurationImport } from './import';
describe('configuration import', () => {
    it('merges selected entities and retains device credentials and unselected modules', async () => {
        let raw: any = { settings: { apiProviders: [{ id: 'a', name: 'Old', type: 'custom', baseUrl: 'https://example.test', apiKey: 'DEVICE-SECRET', enabledModels: [], availableModels: [], verified: false, enabled: true }], maxFunctionCalls: 20 }, workspace: {}, safeGuard: { enabled: true }, hotkeys: {}, resources: { files: {} } };
        const service = new ConfigurationService(createRegistry(), { read: async () => structuredClone(raw), write: async (d, v) => { raw[d] = v; }, activate: async () => ({ reloadRequired: false }), journal: async () => { }, loadJournal: async () => null });
        const inspection: any = { snapshot: { settings: { apiProviders: [{ id: 'a', name: 'New', verified: true }], maxFunctionCalls: 25 }, safeGuard: { enabled: false } }, missingCredentials: [], manifest: { modules: ['settings', 'safeGuard'] } };
        const p = await previewConfigurationImport(service, raw, inspection, { modules: ['settings'] });
        await service.apply({ previewId: p.id, baseRevision: p.baseRevision, requestId: 'import' });
        expect(raw.settings.apiProviders[0].name).toBe('New');
        expect(raw.settings.apiProviders[0].apiKey).toBe('DEVICE-SECRET');
        expect(raw.settings.apiProviders[0].verified).toBe(false);
        expect(raw.safeGuard.enabled).toBe(true);
    });
});
