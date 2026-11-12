import type { App, DataAdapter } from "obsidian";
import { ensureStorageDirectory } from "./storagePaths";
import { sanitizeRagSettingName as sanitizeSettingName } from "obsidian-llm-hub-common/core";
const INDEX_FILENAME = "index.json";
const VECTORS_FILENAME = "vectors.bin";
export type RagContentType = "text" | "image" | "pdf" | "audio" | "video";
export interface LocalRagChunkMeta {
    filePath: string;
    originalFilePath?: string;
    chunkIndex: number;
    text: string;
    contentType?: RagContentType; // undefined treated as "text" for backward compat
    pageLabel?: string; // e.g. "pages 1-6 of 24" for split PDF chunks
}
export interface LocalRagIndex {
    meta: LocalRagChunkMeta[];
    dimension: number;
    fileChecksums: Record<string, string>;
    embeddingModel: string;
    /** SHA-256 of the model and normalized embedding endpoint; absent in old data. */
    embeddingSpace?: string;
    chunkSize: number;
    chunkOverlap: number;
    pdfChunkPages?: number; // undefined treated as 6 for backward compat
    indexMultimodal?: boolean; // undefined treated as false for backward compat
}
const EMPTY_INDEX: LocalRagIndex = {
    meta: [],
    dimension: 0,
    fileChecksums: {},
    embeddingModel: "",
    chunkSize: 0,
    chunkOverlap: 0,
    pdfChunkPages: 6,
};
const configuredRagDirectories = new Map<string, string>();
export function configureRagStorageDirectory(workspaceFolder: string, directory: string): void { configuredRagDirectories.set(workspaceFolder, directory); }
export function getRagDirectory(workspaceFolder: string): string { return configuredRagDirectories.get(workspaceFolder) ?? `${workspaceFolder}/rag`; }
function getRagDir(workspaceFolder: string): string { return getRagDirectory(workspaceFolder); }
function getSettingDir(workspaceFolder: string, settingName: string): string {
    return `${getRagDir(workspaceFolder)}/${sanitizeSettingName(settingName)}`;
}
function getIndexPath(workspaceFolder: string, settingName: string): string {
    return `${getSettingDir(workspaceFolder, settingName)}/${INDEX_FILENAME}`;
}
function getVectorsPath(workspaceFolder: string, settingName: string): string {
    return `${getSettingDir(workspaceFolder, settingName)}/${VECTORS_FILENAME}`;
}
async function ensureDir(app: App, workspaceFolder: string, dirPath: string): Promise<void> {
    const wsExists = await app.vault.adapter.exists(workspaceFolder);
    if (!wsExists) {
        await ensureStorageDirectory(app.vault.adapter, workspaceFolder);
    }
    const ragDir = getRagDir(workspaceFolder);
    const ragExists = await app.vault.adapter.exists(ragDir);
    if (!ragExists) {
        await ensureStorageDirectory(app.vault.adapter, ragDir);
    }
    const dirExists = await app.vault.adapter.exists(dirPath);
    if (!dirExists) {
        await ensureStorageDirectory(app.vault.adapter, dirPath);
    }
}
export async function loadRagIndex(app: App, settingName: string, workspaceFolder: string): Promise<LocalRagIndex | null> {
    return (await loadRagSnapshot(app, settingName, workspaceFolder))?.index ?? null;
}
export async function saveRagIndex(app: App, settingName: string, index: LocalRagIndex, workspaceFolder: string): Promise<void> {
    const dirPath = getSettingDir(workspaceFolder, settingName);
    await ensureDir(app, workspaceFolder, dirPath);
    const indexPath = getIndexPath(workspaceFolder, settingName);
    await app.vault.adapter.write(indexPath, JSON.stringify(index));
}
export async function loadRagVectors(app: App, settingName: string, workspaceFolder: string): Promise<Float32Array | null> {
    return (await loadRagSnapshot(app, settingName, workspaceFolder))?.vectors ?? null;
}
export async function saveRagVectors(app: App, settingName: string, vectors: Float32Array, workspaceFolder: string): Promise<void> {
    const dirPath = getSettingDir(workspaceFolder, settingName);
    await ensureDir(app, workspaceFolder, dirPath);
    const vectorsPath = getVectorsPath(workspaceFolder, settingName);
    await app.vault.adapter.writeBinary(vectorsPath, vectors.buffer.slice(vectors.byteOffset, vectors.byteOffset + vectors.byteLength) as ArrayBuffer);
}
/**
 * Move a setting's index to the directory its new name owns. Without this a
 * rename leaves the index behind under the old directory and the setting starts
 * from an empty index, re-embedding the whole vault.
 */
export async function renameRagIndex(app: App, oldSettingName: string, newSettingName: string, workspaceFolder: string): Promise<void> {
    const oldDir = getSettingDir(workspaceFolder, oldSettingName);
    const newDir = getSettingDir(workspaceFolder, newSettingName), io=app.vault.adapter;
    if(oldDir===newDir||!await io.exists(oldDir))return;
    if(await io.exists(newDir))throw new Error('目标索引目录已存在，未覆盖');
    // Move the complete immutable store, including masks and segment payloads.
    // Both paired and document readers resolve payload leaf names in the current directory.
    await io.rename(oldDir,newDir);
    if(!await io.exists(newDir)||await io.exists(oldDir))throw new Error('索引改名未完成，请保留两侧目录');
}
export async function deleteRagIndex(app: App, settingName: string, workspaceFolder: string): Promise<void> {
    const dirPath = getSettingDir(workspaceFolder, settingName);
    const indexPath = getIndexPath(workspaceFolder, settingName);
    const vectorsPath = getVectorsPath(workspaceFolder, settingName);
    try {
        if (await app.vault.adapter.exists(indexPath)) {
            await app.vault.adapter.remove(indexPath);
        }
        if (await app.vault.adapter.exists(vectorsPath)) {
            await app.vault.adapter.remove(vectorsPath);
        }
        if (await app.vault.adapter.exists(dirPath)) {
            await app.vault.adapter.rmdir(dirPath, true);
        }
    }
    catch {
        // Ignore deletion errors
    }
}
export function createEmptyIndex(): LocalRagIndex {
    return { ...EMPTY_INDEX, meta: [], fileChecksums: {} };
}
export function normalizeExternalRagIndex(raw: unknown): LocalRagIndex {
    const index = raw as Record<string, unknown> | null;
    const metaRaw = Array.isArray(index?.meta) ? index.meta : [];
    // Track per-file chunk counters to assign sequential chunkIndex when source has duplicates
    const fileChunkCounters = new Map<string, number>();
    return {
        meta: metaRaw.map((item) => {
            const meta = item as Record<string, unknown>;
            const filePath = typeof meta.filePath === "string" ? meta.filePath : typeof meta.file_path === "string" ? meta.file_path : "";
            // Assign per-file sequential chunkIndex (external indices may have duplicates or missing values)
            const counter = fileChunkCounters.get(filePath) ?? 0;
            fileChunkCounters.set(filePath, counter + 1);
            return {
                filePath,
                chunkIndex: counter,
                text: typeof meta.text === "string" ? meta.text : "",
                contentType: (meta.contentType ?? meta.content_type) as RagContentType | undefined,
                pageLabel: typeof meta.pageLabel === "string" ? meta.pageLabel : typeof meta.page_label === "string" ? meta.page_label : undefined,
                originalFilePath: typeof meta.originalFilePath === "string" ? meta.originalFilePath : undefined,
            };
        }),
        dimension: Number(index?.dimension ?? 0),
        fileChecksums: (index?.fileChecksums ?? index?.file_checksums ?? {}) as Record<string, string>,
        embeddingModel: typeof index?.embeddingModel === "string" ? index.embeddingModel : typeof index?.embedding_model === "string" ? index.embedding_model : "",
        embeddingSpace: typeof index?.embeddingSpace === 'string' ? index.embeddingSpace : undefined,
        chunkSize: Number(index?.chunkSize ?? index?.chunk_size ?? 0),
        chunkOverlap: Number(index?.chunkOverlap ?? index?.chunk_overlap ?? 0),
        pdfChunkPages: Number(index?.pdfChunkPages ?? index?.pdf_chunk_pages ?? 6),
        indexMultimodal: Boolean(index?.indexMultimodal ?? index?.index_multimodal ?? false),
    };
}
/**
 * Load RAG index from an external (absolute) directory path using Node.js fs.
 */
export async function loadExternalRagSnapshot(dirPath: string): Promise<RagSnapshot | null> {
    try {
        const loader = (window as unknown as {
            require?: (id: string) => unknown;
        }).require;
        if (!loader)
            return null;
        const fs = (loader('fs') as typeof import('fs')).promises;
        const path = loader('path') as typeof import('path');
        const io = { exists: async (p: string) => { try {
                await fs.access(p);
                return true;
            }
            catch {
                return false;
            } }, read: (p: string) => fs.readFile(p, 'utf8'), readBinary: async (p: string) => { const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }, list: async (p: string) => ({ files: (await fs.readdir(p, { withFileTypes: true })).filter(x => x.isFile()).map(x => path.join(p, x.name).replace(/\\/g, '/')), folders: [] }) };
        const base = dirPath.replace(/\\/g, '/');
        if (await io.exists(`${base}/.snapshots`))
            return await loadSnapshotAt(io, base);
        const index = normalizeExternalRagIndex(JSON.parse(await io.read(`${base}/index.json`)));
        const vectors = new Float32Array(await io.readBinary(`${base}/vectors.bin`));
        return pairValid(index, vectors) ? { index, vectors } : null;
    }
    catch {
        return null;
    }
}
export async function loadExternalRagIndex(dirPath: string): Promise<LocalRagIndex | null> { return (await loadExternalRagSnapshot(dirPath))?.index ?? null; }
export async function loadExternalRagVectors(dirPath: string): Promise<Float32Array | null> { return (await loadExternalRagSnapshot(dirPath))?.vectors ?? null; }
/** Immutable paired generations. Only a complete, verified commit record is selectable. */
let generationSerial = 0;
export async function ragDigest(input: string | ArrayBuffer): Promise<string> {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}
export function ragEmbeddingFingerprint(model: string, endpoint?: string): Promise<string> {
    return ragDigest(JSON.stringify([model, (endpoint ?? '').replace(/\/+$/, '')]));
}
type RagSnapshot = {
    index: LocalRagIndex;
    vectors: Float32Array;
};
interface RagCommit {
    version: 1;
    index: string;
    vectors: string;
    indexHash: string;
    vectorsHash: string;
}
function pairValid(index: LocalRagIndex, vectors: Float32Array): boolean {
    return Array.isArray(index.meta) && Number.isInteger(index.dimension) && index.dimension >= 0 &&
        (index.meta.length === 0 || index.dimension > 0) && vectors.length === index.meta.length * index.dimension &&
        vectors.every(Number.isFinite);
}
export async function loadRagSnapshot(app: App, settingName: string, workspaceFolder: string): Promise<RagSnapshot | null> {
    return loadSnapshotAt(app.vault.adapter, getSettingDir(workspaceFolder, settingName));
}
async function readCommit(io: Pick<DataAdapter, 'read' | 'readBinary'>, dir: string, record: string): Promise<RagSnapshot | null> {
    try {
        const commit = JSON.parse(await io.read(record)) as RagCommit;
        const id = record.slice(record.lastIndexOf('commit-') + 7, -5);
        if (commit.version !== 1 || !commit.index.endsWith(`/.snapshots/index-${id}.json`) || !commit.vectors.endsWith(`/.snapshots/vectors-${id}.bin`))
            return null;
        const text = await io.read(`${dir}/index-${id}.json`), binary = await io.readBinary(`${dir}/vectors-${id}.bin`);
        if (await ragDigest(text) !== commit.indexHash || await ragDigest(binary) !== commit.vectorsHash)
            return null;
        const index = JSON.parse(text) as LocalRagIndex, vectors = new Float32Array(binary);
        return pairValid(index, vectors) ? { index, vectors } : null;
    }
    catch {
        return null;
    }
}
async function loadSnapshotAt(io: Pick<DataAdapter, 'exists' | 'list' | 'read' | 'readBinary'>, base: string): Promise<RagSnapshot | null> {
    const dir = `${base}/.snapshots`;
    let records: string[] = [];
    if (typeof io.list === 'function' && await io.exists(dir)) {
        records = (await io.list(dir)).files.filter(p => /\/commit-[0-9-]+\.json$/.test(p)).sort().reverse();
    }
    for (const record of records) {
        const snapshot = await readCommit(io, dir, record);
        if (snapshot)
            return snapshot;
    }
    const indexPath = `${base}/index.json`, vectorsPath = `${base}/vectors.bin`;
    if (!await io.exists(indexPath)) {
        if (records.length)
            throw new Error('RAG索引没有完整可用的保存点，请保留文件并检查磁盘');
        return null;
    }
    const index = JSON.parse(await io.read(indexPath)) as LocalRagIndex;
    const vectors = await io.exists(vectorsPath) ? new Float32Array(await io.readBinary(vectorsPath)) : new Float32Array();
    if (!pairValid(index, vectors))
        throw new Error('RAG索引与向量不匹配，未自动覆盖');
    return { index, vectors };
}
async function writeRagSnapshot(app: App, settingName: string, index: LocalRagIndex, vectors: Float32Array, workspaceFolder: string): Promise<void> {
    if (!pairValid(index, vectors))
        throw new Error('拒绝保存不完整的RAG索引');
    const io = app.vault.adapter, base = getSettingDir(workspaceFolder, settingName), dir = `${base}/.snapshots`;
    await ensureDir(app, workspaceFolder, base);
    if (!await io.exists(dir))
        await io.mkdir(dir);
    const id = `${Date.now()}-${String(++generationSerial).padStart(8, '0')}`;
    const indexPath = `${dir}/index-${id}.json`, vectorsPath = `${dir}/vectors-${id}.bin`;
    const text = JSON.stringify(index), binary = vectors.buffer.slice(vectors.byteOffset, vectors.byteOffset + vectors.byteLength) as ArrayBuffer;
    await io.write(indexPath, text);
    await io.writeBinary(vectorsPath, binary);
    const commit: RagCommit = { version: 1, index: indexPath, vectors: vectorsPath, indexHash: await ragDigest(text), vectorsHash: await ragDigest(binary) };
    if (await ragDigest(await io.read(indexPath)) !== commit.indexHash || await ragDigest(await io.readBinary(vectorsPath)) !== commit.vectorsHash)
        throw new Error('RAG保存校验失败');
    const marker = `${dir}/commit-${id}.json`;
    // The last-written immutable marker makes partial paired writes invisible.
    if (typeof io.rename === 'function') {
        await io.write(`${marker}.tmp`, JSON.stringify(commit));
        await io.rename(`${marker}.tmp`, marker);
    }
    else
        await io.write(marker, JSON.stringify(commit));
    // Retain two verified generations; clean only protocol-owned artifacts.
    if (typeof io.list === 'function' && typeof io.remove === 'function') {
        const files = (await io.list(dir)).files, records = files.filter(p => /\/commit-[0-9-]+\.json$/.test(p)).sort().reverse();
        const keep = new Set<string>();
        let count = 0;
        for (const record of records) {
            if (await readCommit(io, dir, record)) {
                const oldId = record.slice(record.lastIndexOf('commit-') + 7, -5);
                for (const path of [record, `${dir}/index-${oldId}.json`, `${dir}/vectors-${oldId}.bin`])
                    keep.add(path);
                if (++count === 2)
                    break;
            }
        }
        for (const path of files)
            if (!keep.has(path) && /\/(?:commit-[0-9-]+\.json(?:\.tmp)?|index-[0-9-]+\.json|vectors-[0-9-]+\.bin)$/.test(path))
                try {
                    await io.remove(path);
                }
                catch { /* Retry owned housekeeping later. */ }
    }
}
const snapshotWrites = new Map<string, Promise<void>>();
export function saveRagSnapshot(app: App, settingName: string, index: LocalRagIndex, vectors: Float32Array, workspaceFolder: string): Promise<void> {
    const key = `${(app.vault.adapter as {
        basePath?: string;
    }).basePath || ''}|${workspaceFolder}|${settingName}`;
    const pending = (snapshotWrites.get(key) || Promise.resolve()).catch(() => { }).then(() => writeRagSnapshot(app, settingName, index, vectors, workspaceFolder));
    snapshotWrites.set(key, pending);
    const release = () => { if (snapshotWrites.get(key) === pending)
        snapshotWrites.delete(key); };
    void pending.then(release, release);
    return pending;
}
