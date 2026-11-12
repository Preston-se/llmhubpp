import { zipSync, strToU8, strFromU8, Unzip, UnzipInflate } from 'fflate';
import { ConfigurationError, type ConfigDomain, type RawSnapshot } from '../types';
import { assertSafe, isSensitiveKey, hasEmbeddedCredentials, redact } from '../validation';
import { encryptCredentialPayload, type EncryptedCredentials } from './credentials';
const DOMAINS: ConfigDomain[] = ['settings', 'workspace', 'safeGuard', 'hotkeys', 'resources'];
interface BundleManifest {
    formatVersion: 1;
    pluginId: 'llmhubpp';
    version: string;
    created: string;
    modules: ConfigDomain[];
    files: Record<string, string>;
    missingCredentials: string[];
}
export interface BundleInspection {
    manifest: BundleManifest;
    snapshot: Partial<RawSnapshot>;
    missingCredentials: string[];
    credentials?: EncryptedCredentials;
}
export interface ExportOptions {
    version: string;
    modules?: string[];
    includeResources?: boolean;
    password?: string;
    resourcePaths?: string[];
}
async function hash(bytes: Uint8Array): Promise<string> { const result = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)); return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join(''); }
export function collectSecrets(value: unknown, path: string[] = [], out: Record<string, unknown> = {}): Record<string, unknown> {
    if (value && typeof value === 'object')
        for (const [key, v] of Object.entries(value)) {
            if (isSensitiveKey(key) || hasEmbeddedCredentials(v)) {
                if (v !== '' && v !== null && v !== undefined)
                    out[JSON.stringify([...path, key])] = v;
            }
            else
                collectSecrets(v, [...path, key], out);
        }
    return out;
}
export async function exportConfigurationBundle(raw: RawSnapshot, options: ExportOptions): Promise<Uint8Array> {
    const modules = DOMAINS.filter(d => (!options.modules || options.modules.includes(d)) && (d !== 'resources' || options.includeResources));
    const selected = structuredClone(Object.fromEntries(modules.map(d => [d, raw[d]]))) as Partial<RawSnapshot>;
    if (selected.resources) {
        delete selected.resources.__externalRevision;
        const files = selected.resources.files as Record<string, string> ?? {};
        if (!options.resourcePaths?.length)
            throw new ConfigurationError('resource-paths-required');
        if (options.resourcePaths.some(path => !Object.prototype.hasOwnProperty.call(files, path)))
            throw new ConfigurationError('resource-not-found');
        selected.resources.files = Object.fromEntries(Object.entries(files).filter(([path]) => options.resourcePaths?.includes(path)));
    }
    if (selected.workspace) {
        delete selected.workspace.sentPromptHistory;
        delete selected.workspace.discussionSettings;
    }
    if (selected.safeGuard)
        delete selected.safeGuard.contextMemories;
    const secrets = collectSecrets(selected);
    const resourceFiles = selected.resources?.files as Record<string, string> ?? {};
    for (const [path, content] of Object.entries(resourceFiles)) {
        if (options.password) {
            secrets[JSON.stringify(['resources', 'files', path])] = content;
            delete resourceFiles[path];
        }
        else
            throw new ConfigurationError('resource-encryption-required');
    }
    const snapshot = redact(selected, '', 'omit');
    const entries: Record<string, Uint8Array> = { 'config.json': strToU8(JSON.stringify(snapshot)) };
    if (options.password)
        entries['credentials.enc.json'] = strToU8(JSON.stringify(await encryptCredentialPayload(secrets, options.password)));
    const checksums: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(entries))
        checksums[name] = await hash(bytes);
    const manifest: BundleManifest = { formatVersion: 1, pluginId: 'llmhubpp', version: options.version, created: new Date().toISOString(), modules, files: checksums, missingCredentials: Object.keys(secrets) };
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    const bytes = zipSync(entries, { level: 6 });
    if (bytes.length > 20 * 1024 * 1024)
        throw new ConfigurationError('bundle-too-large');
    return bytes;
}
function validateZipDirectory(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--)
        if (view.getUint32(pos, true) === 0x06054b50) {
            eocd = pos;
            break;
        }
    if (eocd < 0 || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0 || eocd + 22 + view.getUint16(eocd + 20, true) !== bytes.length)
        throw new ConfigurationError('invalid-zip');
    const count = view.getUint16(eocd + 10, true);
    if (count > 1000 || count < 1)
        throw new ConfigurationError('bundle-limit');
    let pos = view.getUint32(eocd + 16, true);
    const names = new Set<string>();
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (pos + 46 > eocd || view.getUint32(pos, true) !== 0x02014b50)
            throw new ConfigurationError('invalid-zip');
        const size = view.getUint32(pos + 24, true), length = view.getUint16(pos + 28, true), extra = view.getUint16(pos + 30, true), comment = view.getUint16(pos + 32, true), attr = view.getUint32(pos + 38, true);
        const name = strFromU8(bytes.subarray(pos + 46, pos + 46 + length));
        if (!['manifest.json', 'config.json', 'credentials.enc.json'].includes(name) || names.has(name) || (attr >>> 16 & 0xf000) === 0xa000 || size > 10 * 1024 * 1024)
            throw new ConfigurationError('unsafe-zip-entry');
        names.add(name);
        total += size;
        if (total > 100 * 1024 * 1024)
            throw new ConfigurationError('bundle-limit');
        pos += 46 + length + extra + comment;
    }
    if (pos !== eocd)
        throw new ConfigurationError('invalid-zip');
}
export async function inspectConfigurationBundle(bytes: Uint8Array): Promise<BundleInspection> {
    if (bytes.length > 20 * 1024 * 1024)
        throw new ConfigurationError('bundle-too-large');
    validateZipDirectory(bytes);
    const files: Record<string, Uint8Array> = {};
    let total = 0, count = 0;
    const seen = new Set<string>();
    const unzip = new Unzip(file => {
        if (++count > 1000 || seen.has(file.name) || !['manifest.json', 'config.json', 'credentials.enc.json'].includes(file.name))
            throw new ConfigurationError('unsafe-zip-entry');
        seen.add(file.name);
        let length = 0;
        const parts: Uint8Array[] = [];
        file.ondata = (error, chunk, final) => { if (error)
            throw new ConfigurationError('invalid-zip'); length += chunk.length; total += chunk.length; if (length > 10 * 1024 * 1024 || total > 100 * 1024 * 1024)
            throw new ConfigurationError('bundle-limit'); parts.push(chunk); if (final) {
            const value = new Uint8Array(length);
            let at = 0;
            for (const p of parts) {
                value.set(p, at);
                at += p.length;
            }
            files[file.name] = value;
        } };
        file.start();
    });
    unzip.register(UnzipInflate);
    try {
        for (let at = 0; at < bytes.length; at += 65536)
            unzip.push(bytes.subarray(at, at + 65536), at + 65536 >= bytes.length);
    }
    catch (error) {
        if (error instanceof ConfigurationError)
            throw error;
        throw new ConfigurationError('invalid-zip');
    }
    if (!files['manifest.json'] || !files['config.json'])
        throw new ConfigurationError('missing-bundle-files');
    let manifest: BundleManifest, snapshot: Partial<RawSnapshot>;
    try {
        manifest = JSON.parse(strFromU8(files['manifest.json'])) as BundleManifest;
        snapshot = JSON.parse(strFromU8(files['config.json'])) as Partial<RawSnapshot>;
        assertSafe(manifest);
        assertSafe(snapshot);
    }
    catch {
        throw new ConfigurationError('invalid-bundle-json');
    }
    if (manifest.formatVersion !== 1 || manifest.pluginId !== 'llmhubpp' || !Array.isArray(manifest.modules) || manifest.modules.some(d => !DOMAINS.includes(d)) || !Array.isArray(manifest.missingCredentials) || !manifest.files || typeof manifest.files !== 'object')
        throw new ConfigurationError('unsupported-bundle');
    if (Object.keys(snapshot).some(d => !manifest.modules.includes(d as ConfigDomain)))
        throw new ConfigurationError('invalid-bundle-modules');
    for (const [name, entry] of Object.entries(files))
        if (name !== 'manifest.json' && manifest.files[name] !== await hash(entry))
            throw new ConfigurationError('checksum-mismatch');
    for (const name of Object.keys(manifest.files))
        if (!files[name])
            throw new ConfigurationError('missing-bundle-files');
    return { manifest, snapshot, missingCredentials: manifest.missingCredentials, credentials: files['credentials.enc.json'] ? JSON.parse(strFromU8(files['credentials.enc.json'])) as EncryptedCredentials : undefined };
}
