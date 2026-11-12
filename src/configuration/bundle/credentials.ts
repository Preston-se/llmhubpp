import { ConfigurationError } from '../types';
export interface EncryptedCredentials {
    version: 1;
    algorithm: 'AES-GCM';
    iterations: number;
    salt: number[];
    iv: number[];
    cipher: number[];
}
async function key(password: string, salt: Uint8Array<ArrayBuffer>, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    if (!password)
        throw new ConfigurationError('password-required');
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
export async function encryptCredentialPayload(value: unknown, password: string): Promise<EncryptedCredentials> { const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)); const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(password, salt, 'encrypt'), new TextEncoder().encode(JSON.stringify(value))); return { version: 1, algorithm: 'AES-GCM', iterations: 600000, salt: [...salt], iv: [...iv], cipher: [...new Uint8Array(cipher)] }; }
export async function decryptCredentialPayload(value: EncryptedCredentials, password: string): Promise<unknown> {
    if (value.version !== 1 || value.algorithm !== 'AES-GCM' || value.iterations !== 600000 || value.salt?.length !== 16 || value.iv?.length !== 12 || !Array.isArray(value.cipher) || value.cipher.length > 2 * 1024 * 1024 || [...value.salt, ...value.iv, ...value.cipher].some(b => !Number.isInteger(b) || b < 0 || b > 255))
        throw new ConfigurationError('invalid-encryption');
    try {
        const text = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(value.iv) }, await key(password, new Uint8Array(value.salt), 'decrypt'), new Uint8Array(value.cipher));
        return JSON.parse(new TextDecoder().decode(text)) as unknown;
    }
    catch {
        throw new ConfigurationError('wrong-password-or-corrupt');
    }
}
