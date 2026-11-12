import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { exportConfigurationBundle, inspectConfigurationBundle } from './codec';
import { encryptCredentialPayload, decryptCredentialPayload } from './credentials';
describe('portable configuration bundle', () => {
    const data: any = { settings: { systemPrompt: 'Study', apiProviders: [{ id: 'a', apiKey: 'PRIVATE-FIXTURE' }] }, workspace: { ragSettings: {} }, safeGuard: { enabled: true }, hotkeys: { bindings: {} }, resources: { files: { 'LLMHub/tools/test.md': 'custom' } } };
    it('excludes credentials/resources by default, validates checksums and preserves module selection', async () => {
        const bytes = await exportConfigurationBundle(data, { version: '0.36.7', modules: ['settings', 'safeGuard'] });
        const parsed = await inspectConfigurationBundle(bytes);
        expect(JSON.stringify(parsed)).not.toContain('PRIVATE-FIXTURE');
        expect(parsed.snapshot.settings.systemPrompt).toBe('Study');
        expect(parsed.snapshot.resources).toBeUndefined();
        expect(parsed.missingCredentials).not.toHaveLength(0);
    });
    it('rejects traversal, duplicated normalized entry names and corrupt data', async () => {
        await expect(inspectConfigurationBundle(zipSync({ '../config.json': strToU8('{}') }))).rejects.toThrow();
        const bytes = await exportConfigurationBundle(data, { version: '0.36.7' });
        bytes[bytes.length - 3] ^= 50;
        await expect(inspectConfigurationBundle(bytes)).rejects.toThrow();
    });
    it('encrypts credentials with a password and rejects wrong password or tampering', async () => {
        const encrypted = await encryptCredentialPayload({ key: 'PRIVATE-FIXTURE' }, 'correct horse');
        expect(JSON.stringify(encrypted)).not.toContain('PRIVATE-FIXTURE');
        expect(await decryptCredentialPayload(encrypted, 'correct horse')).toEqual({ key: 'PRIVATE-FIXTURE' });
        await expect(decryptCredentialPayload(encrypted, 'wrong')).rejects.toThrow();
    });
});
