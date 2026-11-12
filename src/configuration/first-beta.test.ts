import { expect, it } from 'vitest';
import { configurationFixture } from './configurationFixture.test-utils';
import { previewConfigurationImport } from './bundle/import';
import { exportConfigurationBundle, inspectConfigurationBundle } from './bundle/codec';
import { executeConfigurationTool } from './mcp/tools';
import { getConfigurationStatus } from './diagnostics';
import { getFieldKnowledge } from './knowledge';
import { createRegistry } from './registry';
import { DEFAULT_REQUEST_CONTROLS } from '../core/requestUsage';

it('rejects an import merged against an old snapshot and retains the concurrent provider edit on retry', async () => {
    const f = configurationFixture(), before = structuredClone(f.raw);
    const bundle = await inspectConfigurationBundle(await exportConfigurationBundle({ ...before, settings: { apiProviders: [{ id: 'a', enabledModels: ['m'] }] } }, { version: 'test' }));
    (f.raw.settings.apiProviders as Record<string, unknown>[])[0].name = 'Concurrent name';
    await expect(previewConfigurationImport(f.service, before, bundle)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.writes).toEqual([]);
    const p = await previewConfigurationImport(f.service, structuredClone(f.raw), bundle);
    await f.service.apply({ previewId: p.id, baseRevision: p.baseRevision, requestId: 'retry' });
    expect((f.raw.settings.apiProviders as Record<string, unknown>[])[0].enabledModels).toEqual(['m']);
    expect((f.raw.settings.apiProviders as Record<string, unknown>[])[0].name).toBe('Concurrent name');
});

it('requires local unlock for an encrypted bundle before producing any partial preview', async () => {
    const f = configurationFixture();
    const source = structuredClone(f.raw);
    source.settings.maxFunctionCalls = 27;
    (source.settings.apiProviders as Record<string, unknown>[])[0].apiKey = 'BUNDLE-SECRET';
    source.resources.files = { 'LLMHub/tools/example.md': 'synthetic resource' };
    const bundle = await inspectConfigurationBundle(await exportConfigurationBundle(source, { version: 'test', includeResources: true, resourcePaths: ['LLMHub/tools/example.md'], password: 'synthetic-password' }));
    await expect(previewConfigurationImport(f.service, f.raw, bundle)).rejects.toMatchObject({ code: 'local-password-required' });
    await expect(previewConfigurationImport(f.service, f.raw, bundle, { password: 'wrong' })).rejects.toMatchObject({ code: 'wrong-password-or-corrupt' });
    expect(f.writes).toEqual([]);
    const p = await previewConfigurationImport(f.service, f.raw, bundle, { password: 'synthetic-password' });
    await f.service.apply({ previewId: p.id, baseRevision: p.baseRevision, requestId: 'unlock' });
    expect(f.raw.settings.maxFunctionCalls).toBe(27);
    expect(f.raw.resources.files).toEqual({ 'LLMHub/tools/example.md': 'synthetic resource' });
    expect((f.raw.settings.apiProviders as Record<string, unknown>[])[0].apiKey).toBe('BUNDLE-SECRET');
});

it('binds an encrypted import to its pre-decryption snapshot when another save occurs', async () => {
    const f = configurationFixture(), source = structuredClone(f.raw);
    source.settings.maxFunctionCalls = 27;
    const bundle = await inspectConfigurationBundle(await exportConfigurationBundle(source, { version: 'test', password: 'synthetic-password' }));
    const pending = previewConfigurationImport(f.service, structuredClone(f.raw), bundle, { password: 'synthetic-password' });
    f.raw.settings.maxFunctionCalls = 29;
    await expect(pending).rejects.toMatchObject({ code: 'conflict' });
    expect(f.raw.settings.maxFunctionCalls).toBe(29);
    expect(f.writes).toEqual([]);
});

it.each([
    ['local-only', 'unchanged'], ['redact', 'unchanged'], ['confirm', 'unchanged'],
    ['local-only', 'confirm'], ['local-only', 'redact'], ['confirm', 'redact'], ['redact', 'confirm'],
])('requires a bound risk receipt when switching outbound from %s to %s', async (before, after) => {
    const f = configurationFixture();
    f.raw.settings.requestControls = { ...DEFAULT_REQUEST_CONTROLS, outbound: before };
    const baseRevision = (await f.service.read()).revision;
    const p = await f.service.preview({ baseRevision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'requestControls.outbound', value: after }] });
    expect(p.risks).toContainEqual(expect.objectContaining({ path: 'settings.requestControls.outbound', level: 'high', reason: expect.stringMatching(/发送|保护|确认|脱敏/) }));
    expect(p.confirmation?.required).toBe(true);
    await expect(f.service.apply({ previewId: p.id, baseRevision, requestId: 'cancelled' })).rejects.toMatchObject({ code: 'confirmation-required' });
    expect(f.writes).toEqual([]);
    await f.service.apply({ previewId: p.id, baseRevision, requestId: 'approved', confirmToken: p.confirmation!.token });
    expect((f.raw.settings.requestControls as Record<string, unknown>).outbound).toBe(after);
});

it('classifies disabling the hard budget as high risk and refuses a receipt from another preview', async () => {
    const f = configurationFixture();
    f.raw.settings.requestControls = { ...DEFAULT_REQUEST_CONTROLS, budgetEnabled: true };
    const baseRevision = (await f.service.read()).revision;
    const patch = { baseRevision, operations: [{ op: 'set' as const, moduleId: 'settings' as const, fieldId: 'requestControls.budgetEnabled', value: false }] };
    const p = await f.service.preview(patch), other = await f.service.preview(patch);
    expect(p.risks).toContainEqual(expect.objectContaining({ path: 'settings.requestControls.budgetEnabled', level: 'high' }));
    await expect(f.service.apply({ previewId: p.id, baseRevision, requestId: 'wrong-receipt', confirmToken: other.confirmation?.token })).rejects.toMatchObject({ code: 'confirmation-invalid' });
    expect(f.writes).toEqual([]);
    await f.service.apply({ previewId: p.id, baseRevision, requestId: 'right-receipt', confirmToken: p.confirmation!.token });
    expect((f.raw.settings.requestControls as Record<string, unknown>).budgetEnabled).toBe(false);
});

it('does not elevate tightening outbound and enabling the budget', async () => {
    const f = configurationFixture();
    f.raw.settings.requestControls = structuredClone(DEFAULT_REQUEST_CONTROLS);
    const p = await f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [
        { op: 'set', moduleId: 'settings', fieldId: 'requestControls.outbound', value: 'local-only' },
        { op: 'set', moduleId: 'settings', fieldId: 'requestControls.budgetEnabled', value: true },
    ] });
    expect(p.risks).toEqual([]);
    expect(p.confirmation).toBeUndefined();
    expect(getFieldKnowledge('settings.requestControls.outbound', createRegistry()).risk).toBe('high');
    expect(getFieldKnowledge('settings.requestControls.budgetEnabled', createRegistry()).risk).toBe('high');
});

it.each([
    ['localOrigins', ['https://allowed.test', 'https://new.test']],
    ['redactionRules', []],
    ['monthlyBudgetCny', 500],
    ['openingBalanceCny', 0],
    ['openingBalanceMonth', '2000-01'],
])('requires protection review when widening or removing %s under active controls', async (field, value) => {
    const f = configurationFixture();
    f.raw.settings.requestControls = {
        ...DEFAULT_REQUEST_CONTROLS, outbound: field === 'redactionRules' ? 'redact' : 'local-only', budgetEnabled: true,
        localOrigins: ['https://allowed.test'], redactionRules: [{ pattern: 'synthetic', replacement: '[hidden]' }],
        monthlyBudgetCny: 300, openingBalanceCny: 50, openingBalanceMonth: new Date().toISOString().slice(0, 7),
    };
    const p = await f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'requestControls.' + field, value }] });
    expect(p.risks).toContainEqual(expect.objectContaining({ path: 'settings.requestControls.' + field, level: 'high' }));
    expect(p.confirmation?.required).toBe(true);
});

it('keeps narrowing origins, lowering the cap and increasing declared spend ordinary', async () => {
    const f = configurationFixture();
    f.raw.settings.requestControls = { ...DEFAULT_REQUEST_CONTROLS, outbound: 'local-only', budgetEnabled: true,
        localOrigins: ['https://allowed.test', 'https://removed.test'], openingBalanceCny: 50, openingBalanceMonth: new Date().toISOString().slice(0, 7) };
    const p = await f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [
        { op: 'set', moduleId: 'settings', fieldId: 'requestControls.localOrigins', value: ['https://allowed.test'] },
        { op: 'set', moduleId: 'settings', fieldId: 'requestControls.monthlyBudgetCny', value: 200 },
        { op: 'set', moduleId: 'settings', fieldId: 'requestControls.openingBalanceCny', value: 60 },
    ] });
    expect(p.risks).toEqual([]);
    expect(p.confirmation).toBeUndefined();
});

it('requires review when resetting the whole request control object removes existing protections', async () => {
    const f = configurationFixture();
    f.raw.settings.requestControls = { ...DEFAULT_REQUEST_CONTROLS, outbound: 'local-only', budgetEnabled: true };
    const p = await f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [{ op: 'clear', moduleId: 'settings', fieldId: 'requestControls' }] });
    expect(p.risks?.map(risk => risk.path)).toEqual(expect.arrayContaining(['settings.requestControls.outbound', 'settings.requestControls.budgetEnabled']));
    expect(p.confirmation?.required).toBe(true);
});

it('refuses custom-resource export through MCP with actionable local instructions', async () => {
    const f = configurationFixture();
    await expect(executeConfigurationTool(f.service, 'configuration_export', { includeResources: true }, { export: async () => ({ handle: 'must-not-return-empty-success' }) }))
        .rejects.toMatchObject({ code: 'local-resource-export-required' });
});

it.each([{ resourcePaths: undefined }, { resourcePaths: [] as string[] }])('requires explicit resource paths for local resource export ($resourcePaths)', async ({ resourcePaths }) => {
    const f = configurationFixture();
    f.raw.resources.files = { 'LLMHub/tools/example.md': 'synthetic text' };
    await expect(exportConfigurationBundle(f.raw, { version: 'test', includeResources: true, resourcePaths, password: 'synthetic-password' }))
        .rejects.toMatchObject({ code: 'resource-paths-required' });
});

it('rejects a selected resource missing from the export snapshot instead of silently dropping it', async () => {
    const f = configurationFixture();
    f.raw.resources.files = {};
    await expect(exportConfigurationBundle(f.raw, { version: 'test', includeResources: true, resourcePaths: ['LLMHub/tools/missing.md'], password: 'synthetic-password' }))
        .rejects.toMatchObject({ code: 'resource-not-found' });
});

it('exposes recovery-required in status before the next write attempt', async () => {
    const f = configurationFixture();
    f.backend.loadJournal = async () => ({ id: 'interrupted', before: f.raw, after: f.raw, domains: ['settings'], state: 'recovery-required', hasSecrets: true });
    await f.service.recover();
    const result = await getConfigurationStatus({ service: f.service });
    expect(result.recoveryRequired).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(result.nextActions).toContain('local-configuration-recovery');
    expect(f.writes).toEqual([]);
});

it('paginates explicit read paths and validates the same limit and cursor contract', async () => {
    const f = configurationFixture(), fieldPaths = ['settings.maxFunctionCalls', 'settings.localLlmConfigs', 'safeGuard.upstreamBaseUrl'];
    const first = await executeConfigurationTool(f.service, 'configuration_read', { fieldPaths, limit: 1 });
    expect(first).toMatchObject({ values: { 'settings.maxFunctionCalls': 20 }, nextCursor: '1' });
    expect(Object.keys((first as { values: object }).values)).toHaveLength(1);
    const last = await executeConfigurationTool(f.service, 'configuration_read', { fieldPaths, limit: 2, cursor: '1' });
    expect(last).toMatchObject({ values: { 'settings.localLlmConfigs': [], 'safeGuard.upstreamBaseUrl': 'http://127.0.0.1:11434' } });
    expect(last).not.toHaveProperty('nextCursor');
    await expect(executeConfigurationTool(f.service, 'configuration_read', { fieldPaths, limit: 0 })).rejects.toMatchObject({ code: 'invalid-arguments' });
    await expect(executeConfigurationTool(f.service, 'configuration_read', { fieldPaths, cursor: '-1' })).rejects.toMatchObject({ code: 'invalid-arguments' });
});
