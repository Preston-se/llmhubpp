import { ConfigurationService } from './service';
import { createRegistry } from './registry';
import type { RawSnapshot, ConfigurationBackend } from './types';
export function configurationFixture() {
    const raw: RawSnapshot = {
        settings: { maxFunctionCalls: 20, localLlmConfigs: [], apiProviders: [{ id: 'a', name: 'Example', type: 'custom', baseUrl: 'https://example.test', apiKey: 'PRIVATE-KEY', enabled: true, verified: false, enabledModels: [], availableModels: [] }] },
        workspace: {}, safeGuard: { upstreamBaseUrl: 'http://127.0.0.1:11434' }, hotkeys: {}, resources: {},
    };
    const writes: string[] = [];
    const backend: ConfigurationBackend = {
        read: async () => structuredClone(raw), write: async (domain, value) => { writes.push(domain); raw[domain] = structuredClone(value); },
        activate: async () => ({ reloadRequired: false }), journal: async () => {}, loadJournal: async () => null,
    };
    return { raw, writes, service: new ConfigurationService(createRegistry(), backend), backend };
}
