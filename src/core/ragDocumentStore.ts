import type { DataAdapter } from 'obsidian';
import type { WorkControl } from './taskManager';
import type { SourceQuality } from './sourceDocuments';
import { DEFAULT_GEMINI_EMBEDDING_MODEL, type RagSetting } from 'src/types';
import { randomUUID } from 'crypto';
import { ragDigest } from './localRagStorage';
import type { LocalRagChunkMeta, LocalRagIndex } from './localRagStorage';
import { getRagDirectory } from './localRagStorage';
import { sanitizeRagSettingName } from 'obsidian-llm-hub-common/core';
type RagSnapshot = { index: LocalRagIndex; vectors: Float32Array };

export interface RagVectorSpace { model: string; fingerprint: string; dimension: number; embeddingSpace?: string }
/** Kept stable to verify existing segment heads that predate embeddingSpace. */
export function ragDocumentConfiguration(setting: RagSetting): string {
  return JSON.stringify([setting.embeddingModel||DEFAULT_GEMINI_EMBEDDING_MODEL,setting.embeddingBaseUrl,setting.chunkSize,setting.chunkOverlap,setting.pdfChunkPages,'document-parser-1']);
}
export interface DocumentChunk extends Omit<LocalRagChunkMeta, 'filePath'> {
  inputHash: string;
  startOffset?: number;
  heading?: string;
}
export interface DocumentHead {
  id: string;
  path: string;
  aliases: string[];
  revision: string;
  sourceHash: string;
  extractedHash: string;
  space: RagVectorSpace;
  count: number;
  meta: string;
  vectors: string;
  metaHash: string;
  vectorsHash: string;
  indexedAt: number;
  dependencies?: Record<string, string>;
  quality?: SourceQuality;
}
export interface DocumentUpdate {
  documentId?:string;
  aliases?: string[];
  path: string;
  sourceHash: string;
  extractedHash: string;
  space: RagVectorSpace;
  chunks: DocumentChunk[];
  vectors: Float32Array;
  dependencies?: Record<string, string>;
  quality?: SourceQuality;
  stillCurrent?: () => boolean | Promise<boolean>;
}
type DocumentEvent = { version: 1; order: string; sequence?: number } & (
  { kind: 'put'; head: DocumentHead } |
  { kind: 'delete'; path: string; id?: string } |
  { kind: 'replace'; heads: DocumentHead[] } |
  { kind: 'checkpoint'; heads: DocumentHead[]; previous: DocumentHead[]; shadowed: string[]; hidden: string[]; replacedBase: boolean }
);
export interface DocumentRow extends LocalRagChunkMeta {
  documentRevision?: string;
  documentId?: string;
  chunkId?: string;
  documentOffset?: number;
  heading?: string;
  score: number;
}
let serial = 0;
const orderId = () => `${Date.now()}-${String(++serial).padStart(10, '0')}-${randomUUID()}`;

async function ensureDirectory(io: DataAdapter, directory: string): Promise<void> {
  const parts = directory.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const path = parts.slice(0, index).join('/');
    if (path && !await io.exists(path)) await io.mkdir(path);
  }
}

/** Immutable document payloads and last-written operations keep updates bounded to one document. */
export class RagDocumentStore {
  private heads = new Map<string, DocumentHead>();
  private previous = new Map<string, DocumentHead>();
  private byPath = new Map<string, string>();
  private shadowed = new Set<string>();
  private hidden = new Set<string>();
  private pendingHidden = new Map<string, number>();
  private visibilityGeneration = 0;
  private loading?: Promise<void>;
  private tail = Promise.resolve();
  private replacedBase = false;
  private active = false;
  private sequence = 0;

  constructor(private readonly io: DataAdapter, readonly directory: string) {}

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      if (typeof this.io.list !== 'function' || !await this.io.exists(this.directory)) return;
      const events = (await this.io.list(this.directory)).files.filter(path => /\/event-.*\.json$/.test(path)).sort();
      const records: DocumentEvent[] = [];
      for (const path of events) {
        const event = JSON.parse(await this.io.read(path)) as DocumentEvent;
        if (event.version !== 1 || !['put', 'delete', 'replace', 'checkpoint'].includes(event.kind)) throw new Error('索引文档记录版本无效');
        if (event.sequence !== undefined && (!Number.isSafeInteger(event.sequence) || event.sequence < 1)) throw new Error('索引发布次序无效');
        records.push(event);
      }
      // Older records keep their historical order. Every new publication is sequenced
      // after them; neither clock changes nor payload preparation order affect replay.
      records.sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      for (const [index,event] of records.entries()) {
        this.sequence = Math.max(this.sequence,event.sequence ?? 0);
        this.apply(event);
        if (index % 100 === 99) await new Promise(resolve => window.setTimeout(resolve, 0));
      }
    })();
    await this.loading;
  }
  private apply(event: DocumentEvent): void {
    this.active = true;
    if (event.kind === 'checkpoint') {
      this.heads = new Map(event.heads.map(head=>[head.id,head]));
      this.byPath = new Map(event.heads.map(head=>[head.path,head.id]));
      this.previous = new Map(event.previous.map(head=>[head.id,head]));
      this.shadowed = new Set(event.shadowed); this.hidden = new Set(event.hidden); this.replacedBase = event.replacedBase;
    } else if (event.kind === 'replace') {
      for (const head of this.heads.values()) this.previous.set(head.id,head);
      this.heads.clear(); this.byPath.clear(); this.shadowed.clear();
      this.replacedBase = true;
      for (const head of event.heads) this.applyHead(head);
    } else if (event.kind === 'delete') {
      const id = event.id ?? this.byPath.get(event.path);
      if (id) this.heads.delete(id);
      if (id) this.previous.delete(id);
      this.byPath.delete(event.path);
      this.shadowed.add(event.path);
      this.hidden.add(event.path);
    } else this.applyHead(event.head);
  }
  private applyHead(head: DocumentHead): void {
    const previous = this.heads.get(head.id);
    if (previous && previous.vectors !== head.vectors) this.previous.set(previous.id,previous);
    if (previous) this.byPath.delete(previous.path);
    const replaced = this.byPath.get(head.path);
    if (replaced && replaced !== head.id) this.heads.delete(replaced);
    this.heads.set(head.id, head);
    this.byPath.set(head.path, head.id);
    for (const path of [head.path, ...head.aliases]) this.shadowed.add(path);
    this.hidden.delete(head.path);
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await before;
    try { await this.load(); return await work(); } finally { release(); }
  }
  /** Publish a prepared event under the store lock. The sequence orders replay independently of preparation. */
  private async publish(event: DocumentEvent, stillCurrent?: () => boolean | Promise<boolean>): Promise<void> {
    event.sequence = ++this.sequence;
    const paths = event.kind === 'put' ? [event.head.path] : event.kind === 'replace' ? event.heads.map(head => head.path) : [];
    const visibility = new Map(paths.map(path => [path, this.pendingHidden.get(path)]));
    await ensureDirectory(this.io, this.directory);
    const file = `${this.directory}/event-${event.order}.json`;
    const text = JSON.stringify(event);
    // Rename only after a read-back check. Incomplete temp files are never replayed.
    await this.io.write(file + '.tmp', text);
    if (await this.io.read(file + '.tmp') !== text) throw new Error('索引提交校验失败');
    if (stillCurrent && !await stillCurrent()) throw new Error('文档已变化，未发布过期结果');
    await this.io.rename(file + '.tmp', file);
    this.apply(event);
    // A newer edit can hide this path while the rename is in flight. Keep that visibility marker.
    if (stillCurrent && !await stillCurrent()) throw new Error('文档在提交期间发生变化，等待最新版本');
    for (const path of paths) if (visibility.get(path) === this.pendingHidden.get(path)) this.pendingHidden.delete(path);
  }
  async isActive(): Promise<boolean> { await this.load(); return this.active || this.hidden.size > 0 || this.pendingHidden.size > 0; }
  async consumesLegacyBase():Promise<boolean>{await this.load();return !this.replacedBase;}
  hide(path: string): void { this.pendingHidden.set(path, ++this.visibilityGeneration); }
  visible(path: string): boolean { return !this.hidden.has(path) && !this.pendingHidden.has(path); }
  rowVisible(row: DocumentRow): boolean {
    if (!this.visible(row.filePath)) return false;
    return row.documentId ? this.heads.get(row.documentId)?.revision === row.documentRevision : !this.replacedBase && !this.shadowed.has(row.filePath);
  }
  async documents(): Promise<DocumentHead[]> { await this.load(); return [...this.heads.values()].filter(head => this.visible(head.path)); }
  async space(): Promise<RagVectorSpace | undefined> { await this.load(); return [...this.heads.values()].find(head => head.space.dimension > 0)?.space; }
  async shadows(path: string): Promise<boolean> { await this.load(); return this.replacedBase || this.shadowed.has(path) || this.hidden.has(path); }
  async head(path: string): Promise<DocumentHead | undefined> { await this.load(); return this.heads.get(this.byPath.get(path) ?? ''); }
  async resolve(documentId: string): Promise<string | null> {
    await this.load(); const head = this.heads.get(documentId);
    return head && this.visible(head.path) ? head.path : null;
  }
  async payload(head: DocumentHead): Promise<{ chunks: DocumentChunk[]; vectors: Float32Array }> {
    const resolve = (stored: string, kind: 'meta'|'vectors') => {
      const leaf = stored.slice(stored.lastIndexOf('/') + 1);
      if (!new RegExp('^' + kind + '-[0-9]+-[0-9]+-[a-f0-9-]+\\.(?:json|bin)$').test(leaf)) throw new Error('索引片段路径无效');
      return this.directory + '/' + leaf;
    };
    const [text, binary] = await Promise.all([this.io.read(resolve(head.meta, 'meta')), this.io.readBinary(resolve(head.vectors, 'vectors'))]);
    if (await ragDigest(text) !== head.metaHash || await ragDigest(binary) !== head.vectorsHash) throw new Error('文档索引片段损坏，请强制重新索引');
    const chunks = JSON.parse(text) as DocumentChunk[];
    const vectors = new Float32Array(binary);
    if (chunks.length !== head.count || vectors.length !== chunks.length * head.space.dimension) throw new Error('文档索引向量不完整');
    return { chunks, vectors };
  }
  async update(input: DocumentUpdate): Promise<DocumentHead> {
    return this.locked(async () => {
      const found = await this.head(input.path),previous=input.documentId&&input.documentId!==found?.id?undefined:found;
      const currentSpace = await this.space();
      if (currentSpace && (currentSpace.fingerprint !== input.space.fingerprint || currentSpace.dimension !== input.space.dimension)) {
        throw new Error('索引配置已变化，请强制重建整个索引');
      }
      const head = await this.prepare(input, previous);
      if (input.stillCurrent && !await input.stillCurrent()) throw new Error('文档已再次变化，等待最新版本');
      await this.publish({ version: 1, order: head.revision, kind: 'put', head }, input.stillCurrent);
      return head;
    });
  }
  async stage(input: DocumentUpdate): Promise<DocumentHead> { await this.load(); return this.prepare(input, await this.head(input.path)); }
  async activate(heads: DocumentHead[], stillCurrent: () => boolean | Promise<boolean>): Promise<void> {
    await this.locked(async () => {
      const space=heads.find(head=>head.space.dimension>0)?.space;
      if (space && heads.some(head => head.space.fingerprint !== space.fingerprint || (head.space.dimension && head.space.dimension !== space.dimension))) throw new Error('重建向量空间不一致');
      await this.publish({ version: 1, order: orderId(), kind: 'replace', heads }, stillCurrent);
    });
  }
  private async prepare(input: DocumentUpdate, previous?: DocumentHead): Promise<DocumentHead> {
    if ((input.chunks.length > 0 && input.space.dimension < 1) || input.vectors.length !== input.chunks.length * input.space.dimension || input.vectors.some(value => !Number.isFinite(value))) {
      throw new Error('文档向量数量或维度无效');
    }
    await ensureDirectory(this.io, this.directory);
    const revision = orderId();
    const meta = `${this.directory}/meta-${revision}.json`, vectors = `${this.directory}/vectors-${revision}.bin`;
    const text = JSON.stringify(input.chunks);
    const binary = input.vectors.buffer.slice(input.vectors.byteOffset, input.vectors.byteOffset + input.vectors.byteLength) as ArrayBuffer;
    const metaHash = await ragDigest(text), vectorsHash = await ragDigest(binary);
    await this.io.write(meta, text); await this.io.writeBinary(vectors, binary);
    if (await ragDigest(await this.io.read(meta)) !== metaHash || await ragDigest(await this.io.readBinary(vectors)) !== vectorsHash) throw new Error('文档片段写入校验失败');
    return { id: input.documentId ?? previous?.id ?? randomUUID(), path: input.path, aliases: [...new Set([...(previous?.aliases ?? []), ...(input.aliases ?? [])])], revision,
      sourceHash: input.sourceHash, extractedHash: input.extractedHash, space: input.space,
      count: input.chunks.length, meta, vectors, metaHash, vectorsHash, indexedAt: Date.now(), dependencies: input.dependencies, quality: input.quality };
  }
  async remove(path: string): Promise<void> {
    this.hide(path);
    await this.locked(async () => this.publish({ version: 1, order: orderId(), kind: 'delete', path, id: this.byPath.get(path) }));
  }
  async rename(oldPath: string, path: string): Promise<boolean> {
    this.hide(oldPath);
    return this.locked(async () => {
      const head = await this.head(oldPath);
      if (!head) return false;
      const next = { ...head, path, aliases: [...new Set([...head.aliases, oldPath])], revision: orderId() };
      await this.publish({ version: 1, order: next.revision, kind: 'put', head: next });
      return true;
    });
  }
  async replace(inputs: DocumentUpdate[], stillCurrent: () => boolean | Promise<boolean>): Promise<void> {
    await this.locked(async () => {
      const heads: DocumentHead[] = [];
      for (const input of inputs) heads.push(await this.prepare(input, await this.head(input.path)));
      if (!await stillCurrent()) throw new Error('重建期间资料发生变化，请重试');
      await this.publish({ version: 1, order: orderId(), kind: 'replace', heads });
    });
  }
  /** Explicit maintenance only: compact metadata and retain current + prior document payloads. */
  async compact(control?: WorkControl): Promise<number> {
    return this.locked(async()=>{
      const heads=[...this.heads.values()];
      for(const [index,head] of heads.entries()){
        await control?.checkpoint(); await this.payload(head);
        control?.update('扫描RAG文档',index+1,heads.length,head.path);
      }
      const previous=[...this.previous.values()].filter(head=>this.heads.has(head.id));
      const event:DocumentEvent={version:1,kind:'checkpoint',order:orderId(),heads,previous,shadowed:[...this.shadowed],hidden:[...this.hidden],replacedBase:this.replacedBase};
      await this.publish(event,async()=>{await control?.checkpoint();return true;});
      const retained=new Set([...heads,...previous].flatMap(head=>[head.meta,head.vectors]).map(path=>path.slice(path.lastIndexOf('/')+1)));
      let removed=0;
      for(const path of (await this.io.list(this.directory)).files){
        await control?.checkpoint(); const leaf=path.slice(path.lastIndexOf('/')+1);
        if((/^event-.*\.json$/.test(leaf)&&leaf!==`event-${event.order}.json`) || (/^(meta|vectors)-[0-9]+-[0-9]+-[a-f0-9-]+\.(json|bin)$/.test(leaf)&&!retained.has(leaf))){await this.io.remove(path);removed++;}
      }
      return removed;
    });
  }
  async *rows(base?: RagSnapshot | null): AsyncGenerator<{ row: DocumentRow; vector: Float32Array }> {
    await this.load();
    if (!this.replacedBase && base) {
      for (let index = 0; index < base.index.meta.length; index++) {
        const meta = base.index.meta[index];
        if (this.shadowed.has(meta.filePath) || !this.visible(meta.filePath)) continue;
        yield { row: { ...meta, score: 0 }, vector: base.vectors.subarray(index * base.index.dimension, (index + 1) * base.index.dimension) };
      }
    }
    let visited = 0;
    for (const head of [...this.heads.values()]) {
      if (++visited % 16 === 0) await new Promise(resolve => window.setTimeout(resolve, 0));
      if (!this.visible(head.path)) continue;
      const payload = await this.payload(head);
      for (let index = 0; index < payload.chunks.length; index++) {
        if (!this.visible(head.path) || this.heads.get(head.id)?.revision !== head.revision) break;
        const chunk = payload.chunks[index];
        yield { row: { ...chunk, filePath: head.path, documentId: head.id, documentRevision: head.revision, chunkId: `${chunk.inputHash}:${index}`,
          documentOffset: chunk.startOffset, score: 0 },
          vector: payload.vectors.subarray(index * head.space.dimension, (index + 1) * head.space.dimension) };
      }
    }
  }
  async find(query: readonly number[], topK: number, base?: RagSnapshot | null, extensions?: string[], threshold = 0, include?: (row: DocumentRow)=>boolean, signal?: AbortSignal): Promise<DocumentRow[]> {
    const best: DocumentRow[] = [];
    for await (const { row, vector } of this.rows(base)) {
      if(signal?.aborted){const error=new Error('任务已取消');error.name='AbortError';throw error;}
      if(include&&!include(row))continue;
      if (extensions?.length && !extensions.some(extension => row.filePath.toLowerCase().endsWith('.' + extension.replace(/^\./, '').toLowerCase()))) continue;
      let dot = 0, left = 0, right = 0;
      if (vector.length !== query.length) throw new Error('检索向量空间与索引不一致');
      for (let index = 0; index < query.length; index++) { dot += query[index] * vector[index]; left += query[index] ** 2; right += vector[index] ** 2; }
      const score = left && right ? dot / Math.sqrt(left * right) : 0;
      if (score <= threshold) continue;
      best.push({ ...row, score }); best.sort((a, b) => b.score - a.score);
      if (best.length > topK) best.pop();
    }
    return best.filter(row => this.rowVisible(row));
  }
}

const stores = new WeakMap<DataAdapter, Map<string, RagDocumentStore>>();
export function getRagDocumentStore(io: DataAdapter, workspace: string, setting: string): RagDocumentStore {
  let entries = stores.get(io);
  if (!entries) { entries = new Map(); stores.set(io, entries); }
  const directory = `${getRagDirectory(workspace)}/${sanitizeRagSettingName(setting)}/.documents`;
  let store = entries.get(directory);
  if (!store) { store = new RagDocumentStore(io, directory); entries.set(directory, store); }
  return store;
}
export function forgetRagDocumentStore(io: DataAdapter, workspace: string, setting: string): void {
  stores.get(io)?.delete(`${getRagDirectory(workspace)}/${sanitizeRagSettingName(setting)}/.documents`);
}
