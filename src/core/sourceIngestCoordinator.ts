import type { App } from "obsidian";
import { ragDigest } from "./localRagStorage";
import { readSourceDocument, SourceDocumentError, isSourcePath } from "./sourceDocuments";
import { SourceManifestStore, currentConvertedPaths, type SourceManifest, type PublishedSource } from "./sourceManifest";
import { GENERATED_FOLDER, matchSourceDirectory, type SourceWatchPolicy } from "./sourceWatchPolicy";
import type { ManagedTask, TaskManager, WorkControl } from "./taskManager";
export interface SourceIngestHost {
  app: App; tasks: TaskManager; policy: () => SourceWatchPolicy; workspace: () => string;
  manifestDirectory?: string;
  managedDirectories?: () => readonly string[];
  isManagedFile?: (path: string) => boolean | Promise<boolean>;
  ensureIndex: (name: string, collectionId: string, alreadyOwned: boolean) => Promise<void>;
  sync: (name: string, markdownPaths: string[], control: WorkControl) => Promise<unknown>;
}

export class SourceIngestCoordinator {
  private pending = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private manifestStore: SourceManifestStore;
  private manifest: SourceManifest | null = null;
  private stopped = false;
  private versionSerial = 0;
  constructor(private readonly host: SourceIngestHost, private readonly options: { stableDelayMs?: number } = {}) {
    this.manifestStore = new SourceManifestStore(host.app.vault.adapter, host.manifestDirectory ?? `${host.app.vault.configDir}/llmhubpp-sources`);
  }
  dispose(): void { this.stopped = true; }
  async enqueue(path: string, manual = false): Promise<void> {
    const policy = this.host.policy();
    try {
      if (this.stopped || (!manual && !policy.enabled) || !this.matches(path, policy)) return;
      const managed = this.host.isManagedFile?.(path);
      if (typeof managed === "boolean" ? managed : managed && await managed) return;
      if (this.stopped) return;
    } catch { return Promise.reject(new SourceDocumentError("invalid-pattern")); }
    const previous = this.pending.get(path);
    if (previous) { this.dirty.add(path); return previous; }
    const work = this.host.tasks.run(`原资料转换 · ${path.split("/").pop()}`, control => this.process(path, control),
      { serial: true, source: path, descriptor: { kind: "source", source: path, setting: policy.indexName } });
    this.pending.set(path, work);
    void work.finally(async () => {
      if (this.pending.get(path) === work) this.pending.delete(path);
      if (this.dirty.delete(path) && !this.stopped) {
        try { if (await this.fingerprint(path) !== this.manifest?.records[path]?.sourceHash) void this.enqueue(path).catch(() => undefined); } catch { /* task already records the missing/failed source */ }
      }
    }).catch(() => undefined);
    return work;
  }
  async rename(path: string, previousPath: string): Promise<void> {
    await this.enqueue(path);
    if (!this.manifest?.records[path] || !this.manifest.records[previousPath] || path === previousPath) return;
    await this.host.tasks.run("更新原资料关联", async control => {
      if (!this.manifest) return;
      const records = { ...this.manifest.records };
      delete records[previousPath];
      const next = { ...this.manifest, records };
      await this.manifestStore.save(next); this.manifest = next;
      await this.host.sync(next.settingName, await currentConvertedPaths(this.host.app.vault.adapter, next), control);
    }, { serial: true });
  }
  async resume(path: string, control: ManagedTask): Promise<void> { await this.process(path, control); }
  async scan(): Promise<void> {
    let failed = false;
    for (const file of this.host.app.vault.getFiles()) {
      try { await this.enqueue(file.path, true); } catch { failed = true; }
    }
    if (failed) throw new SourceDocumentError("conversion-failed");
  }
  async getIndexPaths(name: string): Promise<string[]> {
    this.manifest = await this.manifestStore.load();
    if (!this.manifest || this.manifest.settingName !== name) throw new SourceDocumentError("index-conflict");
    await this.host.ensureIndex(name, this.manifest.collectionId, true);
    return currentConvertedPaths(this.host.app.vault.adapter, this.manifest);
  }
  private matches(path: string, policy: SourceWatchPolicy): boolean {
    return matchSourceDirectory(path, policy, this.host.workspace(), this.host.app.vault.configDir, this.host.managedDirectories?.());
  }
  private async fingerprint(path: string): Promise<string> {
    const io = this.host.app.vault.adapter;
    if (!await io.exists(path)) throw new SourceDocumentError("missing");
    const text = /\.(?:md|txt|csv|html?)$/i.test(path);
    return ragDigest(text ? await io.read(path) : await io.readBinary(path));
  }
  private async directory(path: string): Promise<void> {
    if (!isSourcePath(path)) throw new SourceDocumentError("corrupt");
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!await this.host.app.vault.adapter.exists(folder)) {
        try {
          if (this.host.app.vault.createFolder) await this.host.app.vault.createFolder(folder);
          else await this.host.app.vault.adapter.mkdir(folder);
        } catch (error) { if (!await this.host.app.vault.adapter.exists(folder)) throw error; }
      }
    }
  }
  private async process(path: string, control: WorkControl): Promise<void> {
    const { app } = this.host; const policy = { ...this.host.policy() };
    if (!isSourcePath(path) || !this.matches(path, policy) || await this.host.isManagedFile?.(path)) throw new SourceDocumentError("source-changed");
    await control.checkpoint();
    this.manifest = await this.manifestStore.load();
    if (this.manifest && this.manifest.settingName !== policy.indexName) throw new SourceDocumentError("index-conflict");
    const manifest: SourceManifest = this.manifest ?? { version: 1, settingName: policy.indexName, collectionId: crypto.randomUUID(), records: {} };
    await this.host.ensureIndex(policy.indexName, manifest.collectionId, !!this.manifest);
    if (!this.manifest) { await this.manifestStore.save(manifest); this.manifest = manifest; }
    control.update("等待文件稳定", 0, 1, path);
    let hash = await this.fingerprint(path); let stable = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => window.setTimeout(resolve, this.options.stableDelayMs ?? 400));
      await control.checkpoint();
      const next = await this.fingerprint(path);
      if (hash === next) { stable = true; break; }
      hash = next;
    }
    if (!stable) throw new SourceDocumentError("source-changed");
    const previous = manifest.records[path];
    let intact = previous?.sourceHash === hash;
    if (intact) for (const output of previous.outputs) {
      if (!await app.vault.adapter.exists(output.path) || await ragDigest(await app.vault.adapter.read(output.path)) !== output.hash) intact = false;
    }
    if (!intact) {
      control.update("正在转换Markdown", 0, 1, path);
      const document = await readSourceDocument(app, path, { signal: control.signal, maxChars: 20000000 });
      if (document.truncated) throw new SourceDocumentError("too-large");
      await control.checkpoint();
      if (await this.fingerprint(path) !== hash) throw new SourceDocumentError("source-changed");
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const name = path.split("/").pop()!.replace(/\.[^.]+$/, "");
      let attachment = policy.attachmentFolder ? [parent, policy.attachmentFolder].filter(Boolean).join("/") : "";
      if (!attachment) {
        try {
          const available = await app.fileManager?.getAvailablePathForAttachment(`${name}.ai.md`, path);
          if (available) attachment = available.includes("/") ? available.slice(0, available.lastIndexOf("/")) : "";
        } catch { /* Use a source-side attachment directory when the host cannot resolve one. */ }
        if (!attachment) attachment = [parent, "附件"].filter(Boolean).join("/");
      }
      const version = `${hash.slice(0, 12)}-${Date.now().toString(36)}-${++this.versionSerial}`;
      const directory = `${attachment}/${GENERATED_FOLDER}/${name}/${version}`;
      await this.directory(directory);
      const limit = Math.max(1000, Math.min(1000000, policy.maxMarkdownChars || 120000));
      const outputs: PublishedSource["outputs"] = [];
      const images: string[] = [];
      for (const asset of document.assets) {
        await control.checkpoint();
        const assetPath = `${directory}/assets/${asset.path}`;
        await this.directory(assetPath.slice(0, assetPath.lastIndexOf("/")));
        await app.vault.createBinary(assetPath, Uint8Array.from(asset.bytes).buffer);
        images.push(`![[${assetPath}]]`);
      }
      const parts: string[] = [];
      for (let offset = 0; offset < document.text.length; offset += limit) parts.push(document.text.slice(offset, offset + limit));
      for (let i = 0; i < parts.length; i++) {
        await control.checkpoint();
        const outputPath = `${directory}/${name}${parts.length > 1 ? `-${String(i + 1).padStart(3, "0")}` : ""}.ai.md`;
        const pageAt = (offset: number) => Math.max(1, (document.pageOffsets?.filter(start => start <= offset).length ?? 1));
        const pageLabel = document.numPages ? `pages ${pageAt(i * limit)}-${Math.min(document.numPages, pageAt((i + 1) * limit - 1))} of ${document.numPages}` : "";
        const body = `---\nllmhubpp_source: true\nsource_path: ${JSON.stringify(path)}\nsource_hash: ${hash}\nsource_part: ${i + 1}\n${pageLabel ? `source_page: ${JSON.stringify(pageLabel)}\n` : ""}---\n\n原资料：[[${path}]]\n\n${parts[i]}${i === parts.length - 1 && images.length ? `\n\n## 附图\n\n${images.join("\n\n")}` : ""}\n`;
        control.update("发布文档分段", i + 1, parts.length, path);
        await app.vault.create(outputPath, body);
        outputs.push({ path: outputPath, hash: await ragDigest(body) });
      }
      await app.vault.create(`${directory}/关联资料.md`, `原资料：[[${path}]]\n\n${outputs.map(output => `- [[${output.path}]]`).join("\n")}\n`);
      await control.checkpoint();
      if (await this.fingerprint(path) !== hash) throw new SourceDocumentError("source-changed");
      const next = { ...manifest, records: { ...manifest.records, [path]: { sourcePath: path, sourceHash: hash, outputs, quality: document.quality } } };
      await this.manifestStore.save(next); this.manifest = next;
    }
    const paths = await currentConvertedPaths(app.vault.adapter, this.manifest);
    await control.checkpoint(); control.update("保存RAG索引", 0, paths.length, path);
    await this.host.sync(policy.indexName, paths, control);
    control.saved?.(path); control.update("文档转换完成", 1, 1, path);
  }
}
