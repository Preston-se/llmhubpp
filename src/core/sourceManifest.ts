import type { DataAdapter } from "obsidian";
import { ragDigest } from "./localRagStorage";
import { isSourcePath, SourceDocumentError, type SourceQuality } from "./sourceDocuments";
import { GENERATED_FOLDER } from "./sourceWatchPolicy";
import { ensureStorageDirectory } from "./storagePaths";
export interface PublishedSource { sourcePath: string; sourceHash: string; outputs: Array<{ path: string; hash: string }>; quality?: SourceQuality }
export interface SourceManifest { version: 1; settingName: string; collectionId: string; records: Record<string, PublishedSource> }
const hashPattern = /^[a-f\d]{64}$/;
export class SourceManifestStore {
  private serial = 0;
  constructor(private readonly io: DataAdapter, private readonly directory: string) { }
  async load(): Promise<SourceManifest | null> {
    if (!await this.io.exists(this.directory)) return null;
    const files = (await this.io.list(this.directory)).files.filter(p => /\/manifest-\d+\.json$/.test(p)).sort().reverse();
    if (!files.length) return null;
    // A final generation is a commit, not a candidate. Falling back silently
    // would authorize a destructive full-list sync from an incomplete history.
    const path = files[0];
    try {
        const envelope = JSON.parse(await this.io.read(path)) as { payload: string; hash: string };
        if (await ragDigest(envelope.payload) !== envelope.hash) throw new SourceDocumentError("manifest-invalid");
        const manifest = JSON.parse(envelope.payload) as SourceManifest;
        if (manifest.version !== 1 || !manifest.settingName || !/^[a-z\d_-]{1,80}$/i.test(manifest.collectionId ?? "") || !manifest.records || Array.isArray(manifest.records)) throw new SourceDocumentError("manifest-invalid");
        if (Object.entries(manifest.records).some(([source, record]) => !record || source !== record.sourcePath || !isSourcePath(source)
          || !hashPattern.test(record.sourceHash) || !Array.isArray(record.outputs) || !record.outputs.length
          || record.outputs.some(output => !isSourcePath(output.path) || !output.path.includes(`/${GENERATED_FOLDER}/`) || !output.path.endsWith(".md") || !hashPattern.test(output.hash)))) throw new SourceDocumentError("manifest-invalid");
        this.serial = Number(path.match(/manifest-(\d+)/)?.[1] ?? 0);
        return manifest;
    } catch { throw new SourceDocumentError("manifest-invalid"); }
  }
  async save(manifest: SourceManifest): Promise<void> {
    if (!await this.io.exists(this.directory)) await ensureStorageDirectory(this.io, this.directory);
    this.serial = Math.max(Date.now(), this.serial + 1);
    const payload = JSON.stringify(manifest);
    const path = `${this.directory}/manifest-${String(this.serial).padStart(20, "0")}.json`;
    if (await this.io.exists(path)) throw new SourceDocumentError("manifest-invalid");
    const envelope = JSON.stringify({ payload, hash: await ragDigest(payload) });
    const temporary = `${path}.tmp`;
    if (await this.io.exists(temporary)) throw new SourceDocumentError("manifest-invalid");
    await this.io.write(temporary, envelope);
    if (await this.io.read(temporary) !== envelope) throw new SourceDocumentError("manifest-invalid");
    await this.io.rename(temporary, path);
  }
}

/** Refuse an incomplete or user-edited collection; never turn it into an empty prune request. */
export async function currentConvertedPaths(io: DataAdapter, manifest: SourceManifest): Promise<string[]> {
  const paths: string[] = [];
  for (const record of Object.values(manifest.records)) for (const output of record.outputs) {
    if (!await io.exists(output.path) || await ragDigest(await io.read(output.path)) !== output.hash) throw new SourceDocumentError("source-changed");
    paths.push(output.path);
  }
  return paths;
}
