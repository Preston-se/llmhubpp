import { it, expect } from 'vitest';
import { recoverConfigurationFiles } from './recovery';
import { DEFAULT_SETTINGS } from '../types';
it('restores an interrupted ordinary transaction before runtime start and preserves unchanged secrets', async () => {
    const before: any = { ...structuredClone(DEFAULT_SETTINGS), apiProviders: [{ id: 'a', name: 'A', apiKey: '', verified: false }] };
    delete before.apiProviders[0].apiKey;
    const after = { ...before, maxFunctionCalls: 27, apiProviders: [{ id: 'a', name: 'A', apiKey: 'DEVICE-SECRET', verified: false }, { id: 'new' }] };
    const journal = { id: 'interrupted', before: { settings: before }, after: { settings: after }, domains: ['settings'], hasSecrets: false, state: 'pending' };
    const files = new Map([['plugin/data.json', JSON.stringify(after)], ['plugin/configuration/pending.json', JSON.stringify(journal)]]), app: any = { vault: { configDir: 'config', adapter: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p), mkdir: async () => { }, write: async (p: string, t: string) => files.set(p, t) } } };
    expect(await recoverConfigurationFiles(app, 'plugin')).toBe(true);
    const restored = JSON.parse(files.get('plugin/data.json')!);
    expect(restored.maxFunctionCalls).toBe(20);
    expect(restored.apiProviders).toHaveLength(1);
    expect(restored.apiProviders[0].apiKey).toBe('DEVICE-SECRET');
    expect(files.get('plugin/configuration/pending.json')).toBe('null');
});
it('keeps files intact when a changed secret has no safe recovery reference', async () => {
    const files = new Map([['plugin/data.json', '{"maxFunctionCalls":27}'], ['plugin/configuration/pending.json', JSON.stringify({ before: { settings: {} }, domains: ['settings'], hasSecrets: true })]]), app: any = { vault: { configDir: 'config', adapter: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p), write: async () => { throw Error('must not write'); } } } };
    expect(await recoverConfigurationFiles(app, 'plugin')).toBe(false);
    expect(files.get('plugin/data.json')).toBe('{"maxFunctionCalls":27}');
});
