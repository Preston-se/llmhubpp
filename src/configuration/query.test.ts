import { expect, it, vi } from 'vitest';
import { executeConfigurationTool } from './mcp/tools';
import { configurationFixture } from './configurationFixture.test-utils';

it('rejects a field path used as a module instead of reporting an empty installation', async () => {
    const f = configurationFixture();
    await expect(executeConfigurationTool(f.service, 'configuration_read', { modules: ['settings.localLlmConfigs'] }))
        .rejects.toMatchObject({ code: 'unknown-module', context: { didYouMean: ['settings'] } });
    expect(f.writes).toEqual([]);
});
it('rejects an unknown describe module even when another module is valid', async () => {
    const f = configurationFixture();
    await expect(executeConfigurationTool(f.service, 'configuration_describe', { modules: ['settings', 'nope'] }))
        .rejects.toMatchObject({ code: 'unknown-module' });
});
it('returns one requested scalar without unrelated configuration or credentials', async () => {
    const f = configurationFixture();
    const result = await executeConfigurationTool(f.service, 'configuration_read', { fieldPaths: ['safeGuard.upstreamBaseUrl'], detail: 'summary' });
    expect(result).toMatchObject({ values: { 'safeGuard.upstreamBaseUrl': 'http://127.0.0.1:11434' }, empty: false });
    expect(JSON.stringify(result).length).toBeLessThan(1024);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-KEY');
    expect(JSON.stringify(result)).not.toContain('maxFunctionCalls');
    expect(f.writes).toEqual([]);
});
it('identifies a valid empty model list as empty while retaining its path', async () => {
    const f = configurationFixture();
    await expect(executeConfigurationTool(f.service, 'configuration_read', { fieldPaths: ['settings.localLlmConfigs'] }))
        .resolves.toMatchObject({ values: { 'settings.localLlmConfigs': [] }, empty: true });
});
it('projects a sensitive wildcard field as configured state with stable entity identity', async () => {
    const f = configurationFixture();
    await expect(executeConfigurationTool(f.service, 'configuration_read', { fieldPaths: ['settings.apiProviders.*.apiKey'] }))
        .resolves.toMatchObject({ values: { 'settings.apiProviders.*.apiKey': [{ entityId: 'a', value: { configured: true } }] } });
});
it.each(['settings.apiProviders.0.name', 'settings.typo', 'settings.__proto__.value'])('rejects unknown or positional field path %s', async field => {
    const f = configurationFixture();
    await expect(executeConfigurationTool(f.service, 'configuration_read', { fieldPaths: [field] }))
        .rejects.toMatchObject({ code: 'unknown-field' });
});
it('distinguishes an unknown preview from an expired existing preview', async () => {
    const f = configurationFixture(), snap = await f.service.read();
    await expect(f.service.apply({ previewId: 'never-created', baseRevision: snap.revision, requestId: 'missing' }))
        .rejects.toMatchObject({ code: 'preview-not-found' });
    const p = await f.service.preview({ baseRevision: snap.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 21 }] });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(p.expiresAt + 1);
    try {
        await expect(f.service.apply({ previewId: p.id, baseRevision: snap.revision, requestId: 'expired' }))
            .rejects.toMatchObject({ code: 'preview-expired', context: { expiresAt: p.expiresAt } });
    } finally { clock.mockRestore(); }
});
it('reports the fresh revision for a concurrent configuration modification', async () => {
    const f = configurationFixture(), before = await f.service.read();
    f.raw.settings.maxFunctionCalls = 29;
    const current = await f.service.read();
    await expect(f.service.preview({ baseRevision: before.revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 21 }] }))
        .rejects.toMatchObject({ code: 'conflict', context: { currentRevision: current.revision } });
});
