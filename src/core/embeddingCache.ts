import type { DataAdapter } from 'obsidian';
import type { WorkControl } from './taskManager';
import { ragDigest } from './localRagStorage';
export interface EmbeddingBatchCache {
    load(key: string, count: number): Promise<number[][] | null>;
    save(key: string, rows: number[][]): Promise<void>;
    clear?(): Promise<void>;
    prune?(): Promise<void>;
}
export function validEmbeddingRows(rows: number[][], count: number): boolean {
    return Array.isArray(rows) && rows.length === count && rows.length > 0 && Array.isArray(rows[0]) && rows[0].length > 0 && rows.every(r => Array.isArray(r) && r.length === rows[0].length && r.every(Number.isFinite));
}
export class DiskEmbeddingBatchCache implements EmbeddingBatchCache {
    constructor(private io: DataAdapter, private directory: string, private namespace: string) { }
    private async folder(): Promise<string> { return `${this.directory}/${await ragDigest(this.namespace)}`; }
    private async path(key: string): Promise<string> { return `${await this.folder()}/${await ragDigest(key)}.json`; }
    private async removeOwned(folder: string): Promise<void> {
        if (!await this.io.exists(folder))
            return;
        const entries = await this.io.list(folder);
        for (const file of entries.files)
            if (/\/[a-f0-9]{64}\.json(?:\.tmp)?$/.test(file))
                await this.io.remove(file);
        for (const child of entries.folders)
            if (/\/[a-f0-9]{64}$/.test(child))
                await this.removeOwned(child);
        try {
            await this.io.rmdir(folder, false);
        }
        catch { /* Unknown files are not owned cache artifacts. */ }
    }
    async clear(): Promise<void> { try {
        await this.removeOwned(await this.folder());
        try {
            await this.io.rmdir(this.directory, false);
        }
        catch { /* Other active namespace retained. */ }
    }
    catch { /* Retry bounded cleanup next time. */ } }
    async prune(): Promise<void> {
        if (typeof this.io.list !== 'function' || !await this.io.exists(this.directory))
            return;
        const keep = await this.folder();
        for (const folder of (await this.io.list(this.directory)).folders)
            if (folder !== keep && /\/[a-f0-9]{64}$/.test(folder))
                try {
                    await this.removeOwned(folder);
                }
                catch { /* Do not fail indexing for housekeeping. */ }
    }
    async load(key: string, count: number): Promise<number[][] | null> {
        const path = await this.path(key);
        if (!await this.io.exists(path))
            return null;
        try {
            const data = JSON.parse(await this.io.read(path)) as {
                key: string;
                rows: number[][];
                hash: string;
            };
            if (data.key === key && validEmbeddingRows(data.rows, count) && await ragDigest(JSON.stringify(data.rows)) === data.hash)
                return data.rows;
        }
        catch { /* Partial/corrupt cache is never a completed batch. */ }
        return null;
    }
    async save(key: string, rows: number[][]): Promise<void> {
        if (!validEmbeddingRows(rows, rows.length))
            throw new Error('嵌入向量不完整或维度不一致');
        if (!await this.io.exists(this.directory))
            await this.io.mkdir(this.directory);
        const folder = await this.folder();
        if (!await this.io.exists(folder))
            await this.io.mkdir(folder);
        const path = await this.path(key), text = JSON.stringify({ key, rows, hash: await ragDigest(JSON.stringify(rows)) });
        if (typeof this.io.rename === 'function') {
            const temp = path + '.tmp';
            await this.io.write(temp, text);
            await this.io.rename(temp, path);
        }
        else
            await this.io.write(path, text);
    }
}
export async function cachedEmbeddingBatch(control: WorkControl | undefined, fingerprint: unknown, count: number, request: () => Promise<number[][]>): Promise<number[][]> {
    await control?.checkpoint();
    const key = await ragDigest(JSON.stringify(fingerprint));
    const cached = await control?.batchCache?.load(key, count);
    if (cached)
        return cached;
    const rows = await request();
    if (!validEmbeddingRows(rows, count))
        throw new Error('嵌入服务返回向量数量或维度不完整');
    // Once the request returned, persist even if cancellation arrived meanwhile.
    await control?.batchCache?.save(key, rows);
    return rows;
}
