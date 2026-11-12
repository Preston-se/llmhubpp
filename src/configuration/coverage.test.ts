import { it, expect } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_WORKSPACE_STATE } from '../types';
import { CONFIGURATION_SCHEMAS } from './generatedSchema';
import { createRegistry } from './registry';
import { ConfigurationService } from './service';
it('registers every current settings and workspace field, including new preferences', () => {
    const registry = createRegistry();
    for (const field of Object.keys(DEFAULT_SETTINGS))
        expect(registry.some(d => d.moduleId === 'settings' && d.fieldId === field), field).toBe(true);
    for (const field of Object.keys(DEFAULT_WORKSPACE_STATE))
        expect(registry.some(d => d.moduleId === 'workspace' && d.fieldId === field), field).toBe(true);
    for (const [domain, schema] of Object.entries({ settings: CONFIGURATION_SCHEMAS.LlmHubSettings, workspace: CONFIGURATION_SCHEMAS.WorkspaceState, safeGuard: CONFIGURATION_SCHEMAS.SafeGuard }))
        for (const field of Object.keys(schema.properties ?? {}))
            expect(registry.some(d => d.moduleId === domain && d.fieldId === field)).toBe(true);
    expect(registry.find(d => d.fieldId === 'readingMenus')?.readOnly).toBe(false);
    expect(registry.find(d => d.fieldId === 'settingsAppearance')?.readOnly).toBe(false);
});
it('retains provider credentials on entity update and invalidates verification when a connection changes', async () => {
    let raw: any = { settings: { apiProviders: [{ id: 'a', name: 'A', type: 'custom', baseUrl: 'http://old.test', apiKey: 'SECRET', verified: true, enabled: true, enabledModels: [], availableModels: ['m'] }] }, workspace: {}, safeGuard: {}, hotkeys: {}, resources: {} };
    const service = new ConfigurationService(createRegistry(), { read: async () => structuredClone(raw), write: async (d, v) => { raw[d] = v; }, activate: async () => ({ reloadRequired: false }), journal: async () => { }, loadJournal: async () => null });
    const snap = await service.read(), p = await service.preview({ baseRevision: snap.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'apiProviders.baseUrl', entityId: 'a', value: 'http://new.test' }] });
    await service.apply({ previewId: p.id, baseRevision: snap.revision, requestId: 'change-endpoint' });
    expect(raw.settings.apiProviders[0].apiKey).toBe('SECRET');
    expect(raw.settings.apiProviders[0].verified).toBe(false);
});
