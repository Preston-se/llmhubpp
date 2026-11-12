import { TFile, type App } from 'obsidian';
import { randomUUID } from 'crypto';
import type { RagSetting } from 'src/types';
import { DEFAULT_GEMINI_EMBEDDING_MODEL, isRagIndexIdleSeconds, RAG_INDEX_IDLE_DEFAULT_SECONDS } from 'src/types';
import { ensureStorageDirectory } from './storagePaths';
import { getRagDirectory, ragDigest, ragEmbeddingFingerprint, type LocalRagIndex } from './localRagStorage';
import { legacyRagFileChecksum } from './localRagStore';
import { getRagDocumentStore, ragDocumentConfiguration, type DocumentHead, type DocumentUpdate } from './ragDocumentStore';
import { documentRevisionKey, readDocumentRevision, sourceFingerprint, markdownDependencies, prepareDocumentInput, supportsLifecycleFile, type RagEmbeddingInput } from './ragDocumentInput';
import type { TaskManager, WorkControl } from './taskManager';
import { readConvertedProvenance } from './convertedSourceIndex';

function persistedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const known = new Set(['索引配置已变化，请强制重建整个索引', '旧索引配置不同，请强制重建整个索引', '文档索引片段损坏，请强制重新索引',
    '文档已变化，未发布过期结果', '文档已再次变化，等待最新版本', '任务已取消', '文件已不存在',
    '请先配置本地嵌入模型，或明确选择云端模型', '嵌入维度发生变化，请强制重建整个索引', '旧索引向量空间无法验证，请强制重建整个索引']);
  if (known.has(message)) return message;
  if (message === 'no-text') return '未提取到文字：扫描件需要 OCR 或人工核对';
  if (['unsupported', 'corrupt', 'encrypted', 'too-large'].includes(message)) return '资料解析失败 · ' + message;
  return '索引更新失败；请检查嵌入服务或资料格式后重试';
}

export interface RagLifecycleHost {
  app: App;
  settings(): Record<string, RagSetting>;
  workspace(): string;
  managedDirectories(): readonly string[];
  base(name: string): Promise<{ index: LocalRagIndex; vectors: Float32Array } | null>;
  embed(name: string, inputs: RagEmbeddingInput[], control: WorkControl, automatic: boolean): Promise<number[][]>;
  tasks: Pick<TaskManager, 'run'>;
  idleSeconds?(): number;
  canRunAutomatic?(name: string): boolean;
}
interface Intent {
  setting: string;
  path: string;
  oldPath?: string;
  aliases?: string[];
  supersedes?: { path: string; version: number }[];
  operation: 'update' | 'delete';
  force: boolean;
  version: number;
  priority: number;
  error?: string;
  newIdentity?:string;
  revision?: string;
  waitFrom?: number;
  disposition?: 'remind' | 'suppress';
}
export type DocumentResult = 'updated' | 'current' | 'removed';
export const NOTE_INDEX_TASK_PREFIX = '更新笔记索引 · ';
export type PendingIndexTask = Pick<Intent, 'setting' | 'path' | 'operation'> & (
  | { status: 'waiting'; dueAt: number }
  | { status: 'queued' | 'deferred' }
  | { status: 'held'; reason: 'save' | 'choice' | 'rebuild' }
  | { status: 'failed' | 'cancelled'; error: string }
);
export interface LifecycleStatus { pending: number; failed: number; running?: string; failures: {path:string;reason:string}[]; waiting: number; ready: number; deferred: number; nextReadyAt?: number }
export interface RagLifecycleReport { updated: number; current: number; removed: number; failures: {path:string;reason:string}[] }

class StaleIndexRevision extends Error {
  constructor() { super('文档已再次变化，等待最新版本'); }
}

export class RagLifecycle {
  private pending = new Map<string, Intent>();
  private persistence = new Map<string, Promise<void>>();
  private intentFiles = new Map<string,Map<string,number>>();
  private waiters = new Map<string, {resolve:(result:DocumentResult)=>void;reject:(error:Error)=>void}[]>();
  private timer?: number;
  private timerDue?: number;
  private changes = Promise.resolve();
  private readonly editorText = new Map<string, string>();
  private readonly frozen = new Map<string, number>();
  private running?: {key:string;path:string;version:number};
  private working?: Promise<void>;
  private stopped = false;
  private generation = 0;
  private settingVersions=new Map<string,number>();
  private embeddingTail:Promise<unknown>=Promise.resolve();
  private blocked = new Set<string>();
  private totals = new Map<string, { embedded: number; skipped: number; removed: number }>();
  private configuration(setting: RagSetting): string {
    return ragDocumentConfiguration(setting);
  }
  private listeners = new Set<() => void>();

  constructor(private readonly host: RagLifecycleHost, private readonly options: { debounceMs?: number } = {}) {}
  private key(setting: string, path: string): string { return JSON.stringify([setting,path]); }
  private get directory(): string { return getRagDirectory(this.host.workspace()) + '/.pending-documents'; }
  private async intentPath(key: string,intent:Intent): Promise<string> { return `${this.directory}/${await ragDigest(key)}-${intent.version}-${intent.error?'failed':'pending'}.json`; }
  private trackIntent(key:string,path:string,version:number):void {const files=this.intentFiles.get(key)??new Map<string,number>();files.set(path,version);this.intentFiles.set(key,files);}
  private async removeIntentFiles(key:string,version:number):Promise<void>{
    const files=this.intentFiles.get(key);if(!files)return;
    for(const [path,savedVersion] of files)if(savedVersion<=version){if(await this.host.app.vault.adapter.exists(path))await this.host.app.vault.adapter.remove(path);files.delete(path);}
    if(!files.size)this.intentFiles.delete(key);
  }
  observe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private setting(name: string): RagSetting {
    const setting = this.host.settings()[name];
    if (!setting || setting.externalIndexPath || setting.sourceRagSettings.length || setting.sourceCollection) throw new Error('请选择内部可写索引');
    return setting;
  }
  matches(name: string, path: string): boolean {
    const setting = this.setting(name);
    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !supportsLifecycleFile(file,setting)) return false;
    if (path.split('/').some(part=>part.startsWith('.'))) return false;
    if (this.host.managedDirectories().some(directory=>directory && (path===directory || path.startsWith(directory+'/')))) return false;
    if (setting.targetFolders.length && !setting.targetFolders.some(folder=>path===folder.replace(/\/$/,'') || path.startsWith(folder.replace(/\/$/,'')+'/'))) return false;
    return !setting.excludePatterns.some(pattern=>new RegExp(pattern).test(path));
  }
  targets(path: string): string[] {
    return Object.entries(this.host.settings()).filter(([,setting])=>!setting.externalIndexPath&&!setting.sourceRagSettings.length&&!setting.sourceCollection)
      .map(([name])=>name).filter(name=>this.matches(name,path));
  }
  status(name: string): LifecycleStatus {
    const intents = [...this.pending.values()].filter(intent=>intent.setting===name);
    const eligible = intents.filter(intent => this.canRun(intent));
    const ready = eligible.filter(intent => this.readyAt(intent) <= Date.now()).length;
    const future = eligible.map(intent => this.readyAt(intent)).filter(time => time > Date.now());
    const deferred = intents.filter(intent => intent.disposition).length;
    return { pending:intents.filter(intent=>!intent.error).length, failed:intents.filter(intent=>!!intent.error).length,
      running:this.running && this.pending.get(this.running.key)?.setting===name ? this.running.path : undefined,
      failures:intents.filter(intent=>intent.error).map(intent=>({path:intent.path,reason:intent.error!})),
      deferred, ready, waiting: intents.filter(intent => !intent.error && !intent.disposition).length - ready,
      nextReadyAt: future.length ? Math.min(...future) : undefined };
  }

  /** Read the scheduler's current intent for each index and note. Running revisions are in TaskManager. */
  listPendingIndexTasks(now = Date.now()): PendingIndexTask[] {
    if (this.stopped) return [];
    const renameSources = this.renameSourceKeys();
    const tasks: PendingIndexTask[] = [];
    for (const [key, intent] of this.pending) {
      if (renameSources.has(key) || (this.running?.key === key && this.running.version === intent.version)) continue;
      const target = { setting: intent.setting, path: intent.path, operation: intent.operation };
      if (intent.error) {
        const cancelled = intent.error === '任务已取消' || intent.error === '已取消，可手动重试';
        tasks.push({ ...target, status: cancelled ? 'cancelled' : 'failed', error: intent.error });
      } else if (this.canRun(intent)) {
        const dueAt = this.readyAt(intent);
        tasks.push(dueAt > now ? { ...target, status: 'waiting', dueAt } : { ...target, status: 'queued' });
      } else if (this.canRun(intent, true)) {
        const reason = this.blocked.has(intent.setting) ? 'rebuild' : this.frozen.has(intent.path) ? 'choice' : 'save';
        tasks.push({ ...target, status: 'held', reason });
      } else {
        tasks.push({ ...target, status: 'deferred' });
      }
    }
    return tasks;
  }
  async initialize(): Promise<void> {
    if (!await this.host.app.vault.adapter.exists(this.directory)) return;
    for (const file of (await this.host.app.vault.adapter.list(this.directory)).files.filter(path=>/\/[a-f0-9]{64}(?:-\d+-(?:pending|failed))?\.json$/.test(path))) {
      const intent = JSON.parse(await this.host.app.vault.adapter.read(file)) as Intent;
      if (!this.host.settings()[intent.setting] || typeof intent.path!=='string') continue;
      if (intent.waitFrom === undefined) intent.waitFrom = Date.now();
      const key=this.key(intent.setting,intent.path);
      this.settingVersions.set(intent.setting,Math.max(this.settingVersions.get(intent.setting)??0,intent.version));
      this.trackIntent(key,file,intent.version);
      const previous=this.pending.get(key);this.generation=Math.max(this.generation,intent.version);
      if(previous&&(previous.version>intent.version||(previous.version===intent.version&&previous.error)))continue;
      this.pending.set(key,intent);
      if (intent.operation==='delete') getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),intent.setting).hide(intent.path);
      if (intent.oldPath) getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),intent.setting).hide(intent.oldPath);
      if (intent.newIdentity) getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),intent.setting).hide(intent.path);
    }
    // Upgrade destination-keyed queues written before rename chains were persisted.
    for(const intent of [...this.pending.values()].sort((a,b)=>a.version-b.version)){
      if(!intent.oldPath||this.pending.get(this.key(intent.setting,intent.path))!==intent)continue;
      const sourceKey=this.key(intent.setting,intent.oldPath),source=this.pending.get(sourceKey);
      if(!source||source.version>=intent.version)continue;
      const key=this.key(intent.setting,intent.path);
      const next:Intent={...intent,oldPath:source.oldPath??intent.oldPath,version:++this.generation,
        aliases:[...new Set([...(source.aliases??[]),...(intent.aliases??[]),intent.oldPath])],
        supersedes:[...(source.supersedes??[]),...(intent.supersedes??[]),{path:source.path,version:source.version}],newIdentity:intent.newIdentity??source.newIdentity};
      this.pending.set(key,next);this.pending.delete(sourceKey);this.settingVersions.set(intent.setting,next.version);
      await this.persist(key,next);await this.removeIntentFiles(key,intent.version);await this.removeIntentFiles(sourceKey,source.version);
    }
    // A crash may leave the last rename and its superseded intermediate intent.
    // The newest durable chain owns those paths, including moves outside scope.
    for (const intent of [...this.pending.values()].sort((a,b)=>b.version-a.version)) {
      for (const source of intent.supersedes ?? []) {
        const key=this.key(intent.setting,source.path),previous=this.pending.get(key);
        if (previous && previous.version<=source.version) { this.pending.delete(key);await this.removeIntentFiles(key,source.version); }
      }
    }
    this.refreshIdlePolicy();
  }
  private async persist(key: string, intent: Intent): Promise<void> {
    const previous=this.persistence.get(key) ?? Promise.resolve();
    const saving=previous.catch(()=>{}).then(async()=>{
      await ensureStorageDirectory(this.host.app.vault.adapter,this.directory);
      const path=await this.intentPath(key,intent);
      if(await this.host.app.vault.adapter.exists(path))return;
      await this.host.app.vault.adapter.write(path+'.tmp',JSON.stringify(intent));
      await this.host.app.vault.adapter.rename(path+'.tmp',path);
      this.trackIntent(key,path,intent.version);
    });
    this.persistence.set(key,saving);
    try { await saving; } finally { if(this.persistence.get(key)===saving)this.persistence.delete(key); }
  }
  private async enqueue(setting: string, path: string, operation: Intent['operation'], force=false, manual=false, oldPath?: string,
    revision?: string, waitFrom = Date.now()): Promise<string> {
    this.setting(setting);
    const key=this.key(setting,path),previous=this.pending.get(key);
    const sourceKey=oldPath?this.key(setting,oldPath):undefined,source=sourceKey?this.pending.get(sourceKey):undefined;
    const origin=source?.oldPath??oldPath??previous?.oldPath;
    const aliases=[...new Set([...(previous?.aliases??[]),...(source?.aliases??[]),...(oldPath?[oldPath]:[])])];
    const movedAway=!oldPath&&[...this.pending.values()].some(intent=>intent.setting===setting&&intent.oldPath===path&&intent.path!==path);
    if (!manual && previous?.priority && !oldPath && operation === 'update') this.finish(key, undefined, new StaleIndexRevision());
    const intent:Intent={setting,path,operation,force,priority:manual?2:0,version:++this.generation,oldPath:origin,aliases,revision,
      waitFrom: !manual && revision !== undefined && revision === source?.revision ? source.waitFrom ?? waitFrom : waitFrom,
      disposition: !manual && operation === 'update' && revision !== undefined && revision === source?.revision ? source?.disposition : undefined,
      supersedes:[...(source?.supersedes??[]),...(source&&sourceKey!==key?[{path:source.path,version:source.version}]:[])],
      newIdentity:source?.newIdentity??(oldPath
        ? (source?.operation==='delete'&&!source.oldPath?randomUUID():undefined)
        : previous?.newIdentity??(operation==='update'&&((previous?.operation==='delete'&&!previous.oldPath)||movedAway)?randomUUID():undefined))};
    this.pending.set(key,intent);
    if(sourceKey&&sourceKey!==key&&source){
      this.pending.delete(sourceKey);
      const waiting=this.waiters.get(sourceKey);if(waiting){this.waiters.set(key,[...(this.waiters.get(key)??[]),...waiting]);this.waiters.delete(sourceKey);}
    }
    this.settingVersions.set(setting,intent.version);
    if(operation==='delete')getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),setting).hide(path);
    if(origin)getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),setting).hide(origin);
    await this.persist(key,intent);
    await this.removeIntentFiles(key, intent.version - 1);
    if(sourceKey&&sourceKey!==key&&source){await this.persistence.get(sourceKey);await this.removeIntentFiles(sourceKey,source.version);}
    this.refreshIdlePolicy();
    return key;
  }
  async changed(kind: 'create'|'modify'|'rename'|'delete', path: string, oldPath?: string): Promise<void> {
    if(this.stopped)return;
    const observedAt = Date.now();
    const eligible = new Set(this.targets(path));
    const change = this.changes.then(() => this.recordChange(kind, path, oldPath, observedAt, eligible));
    this.changes = change.catch(() => undefined);
    return change;
  }
  private async recordChange(kind: 'create'|'modify'|'rename'|'delete', path: string, oldPath: string | undefined,
    observedAt: number, eligible: Set<string>): Promise<void> {
    if (this.stopped) return;
    const app = this.host.app;
    const file = app.vault.getAbstractFileByPath(path);
    const revision = file instanceof TFile && eligible.size ? await readDocumentRevision(app, file) : undefined;
    let releasedEditor = false;
    if (revision && this.editorText.has(path) && await ragDigest(this.editorText.get(path)!) === revision.sourceHash)
      releasedEditor = this.editorText.delete(path);
    if (oldPath || kind === 'delete') releasedEditor = this.editorText.delete(oldPath ?? path) || releasedEditor;
    for(const [name,setting] of Object.entries(this.host.settings())){
      if(setting.externalIndexPath||setting.sourceRagSettings.length||setting.sourceCollection)continue;
      const store=getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),name);
      const previous=oldPath??path;
      const head = await store.head(previous);
      const pending = this.pending.get(this.key(name, previous));
      if(kind==='delete'||(oldPath&&!eligible.has(name))){
        if (head || pending || (await this.host.base(name))?.index.fileChecksums[previous] !== undefined) {
          await this.enqueue(name,path,'delete',false,false,oldPath);
        }
      } else if (setting.autoUpdateIndex && eligible.has(name) && (revision || oldPath)) {
        if (oldPath || (pending?.revision !== revision?.key && (pending || !head || documentRevisionKey(head.sourceHash, head.dependencies) !== revision?.key))) {
          if (oldPath || pending || head || !revision?.empty || (await this.host.base(name))?.index.fileChecksums[path] !== undefined) {
            const same = oldPath && head && documentRevisionKey(head.sourceHash, head.dependencies) === revision?.key && !pending;
            await this.enqueue(name,path,'update',false,false,oldPath,revision?.key,same ? observedAt - this.idleMs() : observedAt);
          }
        }
      }
      // Attachment changes refresh only documents that recorded that dependency.
      if (setting.autoUpdateIndex) for (const owner of await store.documents()) {
        if (owner.path === path || (owner.dependencies?.[previous] === undefined && owner.dependencies?.[path] === undefined
          && !Object.entries(owner.dependencies ?? {}).some(([link, hash]) => hash === 'missing' && link.split('/').at(-1) === path.split('/').at(-1)))) continue;
        const dependent = app.vault.getAbstractFileByPath(owner.path);
        if (!(dependent instanceof TFile) || !this.matches(name, owner.path)) continue;
        const next = await readDocumentRevision(app, dependent);
        const queued = this.pending.get(this.key(name, owner.path));
        if ((queued?.revision ?? documentRevisionKey(owner.sourceHash, owner.dependencies)) !== next.key) {
          await this.enqueue(name, owner.path, 'update', false, false, undefined, next.key, observedAt);
        }
      }
    }
    this.schedule();
    if (releasedEditor) this.notify();
  }
  async updateNow(name: string, path: string, force=false): Promise<DocumentResult> {
    await this.settleNoteChanges();
    if(!this.matches(name,path))throw new Error('该笔记不在当前可写索引范围内');
    if (this.editorText.has(path)) throw new Error('笔记尚未保存，请保存后再更新索引');
    if (this.frozen.has(path)) throw new Error('请先完成此笔记的索引选择');
    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('文件已不存在');
    const revision = (await readDocumentRevision(this.host.app, file)).key;
    const key=this.key(name,path);
    const result=new Promise<DocumentResult>((resolve,reject)=>{const waiting=this.waiters.get(key)??[];waiting.push({resolve,reject});this.waiters.set(key,waiting);});
    try {await this.enqueue(name,path,'update',force,true,undefined,revision);void this.flush();}catch(error){this.finish(key,undefined,error); }
    return result;
  }
  private idleMs(): number {
    const value = this.host.idleSeconds?.();
    return this.options.debounceMs ?? 1000 * (isRagIndexIdleSeconds(value) ? value : RAG_INDEX_IDLE_DEFAULT_SECONDS);
  }
  private canRun(intent: Intent, includeHeld = false): boolean {
    if (intent.error || intent.disposition || (!includeHeld && (this.blocked.has(intent.setting) || this.frozen.has(intent.path)))) return false;
    const setting = this.host.settings()[intent.setting];
    if (!setting || setting.externalIndexPath || setting.sourceRagSettings.length || setting.sourceCollection) return false;
    if (intent.operation === 'delete') return true;
    return (includeHeld || !this.editorText.has(intent.path)) && (intent.priority > 0 ||
      !!setting.autoUpdateIndex && this.host.canRunAutomatic?.(intent.setting) !== false);
  }
  private readyAt(intent: Intent): number {
    return intent.operation === 'delete' || intent.priority > 0 ? 0 : (intent.waitFrom ?? 0) + this.idleMs();
  }
  private renameSourceKeys(): Set<string> {
    return new Set([...this.pending.values()]
      .filter(intent => !intent.error && intent.oldPath && intent.oldPath !== intent.path)
      .map(intent => this.key(intent.setting, intent.oldPath!)));
  }
  private runnableEntries(): [string, Intent][] {
    const renameSources = this.renameSourceKeys();
    return [...this.pending].filter(([key, intent]) => this.canRun(intent) && !renameSources.has(key));
  }
  private schedule(): void {
    let earliest = Infinity;
    if (!this.stopped && !this.working) for (const [, intent] of this.runnableEntries()) earliest = Math.min(earliest, this.readyAt(intent));
    if (this.timer !== undefined && this.timerDue === earliest) return;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDue = earliest;
    if (earliest < Infinity) this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(() => this.notify());
    }, Math.max(0, earliest - Date.now()));
  }
  refreshIdlePolicy(): void { this.schedule(); this.notify(); }
  noteEditorChanged(path: string, text: string): void {
    if (!this.targets(path).some(name => this.host.settings()[name]?.autoUpdateIndex)) return;
    const held = this.editorText.has(path);
    this.editorText.set(path, text);
    this.schedule();
    if (!held) this.notify();
  }
  releaseEditorChange(path: string): void {
    const released = this.editorText.delete(path);
    this.schedule();
    if (released) this.notify();
  }
  unsavedNotePaths(): string[] { return [...this.editorText.keys()]; }
  async settleNoteChanges(): Promise<void> {
    await this.changes;
  }
  pendingNotePaths(): string[] {
    return [...new Set([...this.pending.values()].filter(intent => intent.operation === 'update' && !intent.error && !intent.disposition
      && (intent.priority > 0 || this.host.settings()[intent.setting]?.autoUpdateIndex)).map(intent => intent.path))];
  }
  freezeNoteUpdates(paths: readonly string[]): void {
    for (const path of paths) this.frozen.set(path, (this.frozen.get(path) ?? 0) + 1);
    this.refreshIdlePolicy();
  }
  unfreezeNoteUpdates(paths: readonly string[]): void {
    for (const path of paths) {
      const count = this.frozen.get(path) ?? 0;
      if (count > 1) this.frozen.set(path, count - 1);
      else this.frozen.delete(path);
    }
    this.refreshIdlePolicy();
  }
  async chooseNoteUpdates(paths: readonly string[], choice: 'wait' | 'remind' | 'suppress'): Promise<void> {
    const selected = new Set(paths);
    for (const [key, intent] of [...this.pending]) {
      if (!selected.has(intent.path) || intent.operation !== 'update' || (intent.error && choice !== 'remind') ||
        (choice === 'suppress' ? intent.disposition !== 'remind' : !!intent.disposition)) continue;
      if (this.pending.get(key) !== intent) continue;
      const next: Intent = { ...intent, version: ++this.generation, priority: 0, force: false, error: undefined,
        waitFrom: choice === 'wait' ? Date.now() : intent.waitFrom, disposition: choice === 'wait' ? undefined : choice };
      this.pending.set(key, next);
      this.settingVersions.set(intent.setting, next.version);
      if (intent.priority) this.finish(key, undefined, new StaleIndexRevision());
      await this.persist(key, next);
      await this.removeIntentFiles(key, next.version - 1);
    }
    this.refreshIdlePolicy();
  }
  async getOpenReminder(path: string): Promise<boolean> {
    await this.settleNoteChanges();
    if (![...this.pending.values()].some(intent => intent.path === path && intent.disposition === 'remind' && this.host.settings()[intent.setting]?.autoUpdateIndex)) return false;
    await this.changed('modify', path);
    if (![...this.pending.values()].some(intent => intent.path === path && intent.disposition === 'remind' && this.host.settings()[intent.setting]?.autoUpdateIndex)) return false;
    await this.chooseNoteUpdates([path], 'suppress');
    return true;
  }
  async updatePendingNotes(paths: readonly string[]): Promise<RagLifecycleReport> {
    const selected = new Set(paths);
    const intents = [...this.pending.values()].filter(intent => selected.has(intent.path) && intent.operation === 'update' && !intent.error
      && (intent.priority > 0 || this.host.settings()[intent.setting]?.autoUpdateIndex));
    const report: RagLifecycleReport = { updated: 0, current: 0, removed: 0, failures: [] };
    for (const intent of intents) {
      try { report[await this.updateNow(intent.setting, intent.path)]++; }
      catch (error) { report.failures.push({ path: intent.path, reason: persistedFailure(error) }); }
    }
    return report;
  }
  async flush(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    await this.drain();
  }
  private async drain(): Promise<void> {
    if(this.working)return this.working;
    this.working=(async()=>{
      while(!this.stopped){
        await this.settleNoteChanges();
        await Promise.all(this.persistence.values());
        if (this.stopped) break;
        const next = this.runnableEntries().filter(([, intent]) => this.readyAt(intent) <= Date.now())
          .sort((a,b)=>b[1].priority-a[1].priority||this.readyAt(a[1])-this.readyAt(b[1])||a[1].version-b[1].version)[0];
        if(!next)break;
        const [key,intent]=next;this.running={key,path:intent.path,version:intent.version};this.notify();
        try{
          const result=await this.host.tasks.run(NOTE_INDEX_TASK_PREFIX+intent.path,control=>this.process(intent,control),{source:intent.path,descriptor:{kind:'custom',setting:intent.setting,source:intent.path}});
          if(this.pending.get(key)?.version===intent.version){
            const previous=this.persistence.get(key)??Promise.resolve();
            const cleanup=previous.catch(()=>{}).then(async()=>{
              if(this.pending.get(key)?.version!==intent.version)return;
              this.pending.delete(key);
              const totals=this.totals.get(intent.setting)??{embedded:0,skipped:0,removed:0};
              totals[result==='current'?'skipped':result==='removed'?'removed':'embedded']++;
              this.totals.set(intent.setting,totals);
              await this.removeIntentFiles(key,intent.version);
              if(!this.pending.has(key))this.finish(key,result);
            });
            this.persistence.set(key,cleanup);
            try{await cleanup;}finally{if(this.persistence.get(key)===cleanup)this.persistence.delete(key);}
          }
        }catch(error){
          if(this.pending.get(key)?.version===intent.version){
            if (error instanceof StaleIndexRevision || !this.canRun(intent)) continue;
            intent.error=persistedFailure(error);await this.persist(key,intent);
            if(this.pending.get(key)?.version===intent.version)this.finish(key,undefined,error);
          }
        }finally{this.running=undefined;this.notify();}
      }
    })();
    try{await this.working;}finally{this.working=undefined;this.schedule();}
  }
  private finish(key: string, result?: DocumentResult, error?: unknown): void {
    for(const waiter of this.waiters.get(key)??[])if(error)waiter.reject(error instanceof Error?error:new Error('索引更新失败'));else waiter.resolve(result??'updated');
    this.waiters.delete(key);
  }
  private async process(intent: Intent, taskControl: WorkControl): Promise<DocumentResult> {
    const current = () => !this.stopped && this.pending.get(this.key(intent.setting, intent.path))?.version === intent.version
      && this.canRun(intent) && this.readyAt(intent) <= Date.now();
    const control: WorkControl = {
      signal: taskControl.signal,
      batchCache: taskControl.batchCache,
      update: (...args) => taskControl.update(...args),
      saved: taskControl.saved?.bind(taskControl),
      checkpoint: async () => {
        await taskControl.checkpoint();
        await this.settleNoteChanges();
        if (!current()) throw new StaleIndexRevision();
      },
    };
    await control.checkpoint();
    const store=getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),intent.setting);
    if(intent.operation==='delete'){await store.remove(intent.oldPath??intent.path);if(intent.oldPath&&intent.oldPath!==intent.path)await store.remove(intent.path);return 'removed';}
    if(!this.matches(intent.setting,intent.path)){await store.remove(intent.path);return 'removed';}
    if(intent.oldPath){
      for(const path of [intent.oldPath,...(intent.aliases??[])])if(await store.rename(path,intent.path))break;
    }
    const update=await this.prepare(intent,control);
    if(!update)return 'current';
    await control.checkpoint();await store.update(update);control.saved?.(intent.path);return 'updated';
  }
  private async prepare(intent: Intent, control: WorkControl, rebuilding = false): Promise<DocumentUpdate | null> {
    const version = intent.version;
    const setting=this.setting(intent.setting),app=this.host.app;
    const file=app.vault.getAbstractFileByPath(intent.path);
    if(!(file instanceof TFile))throw new Error('文件已不存在');
    const store=getRagDocumentStore(app.vault.adapter,this.host.workspace(),intent.setting);
    let previous=rebuilding&&intent.oldPath?undefined:await store.head(intent.path);
    if(rebuilding&&intent.oldPath)for(const path of [intent.oldPath,...(intent.aliases??[])]){previous=await store.head(path);if(previous)break;}
    const sourceHash=await sourceFingerprint(app,file);
    const dependencies=await markdownDependencies(app,file);
    if (!rebuilding && intent.revision !== undefined && intent.revision !== documentRevisionKey(sourceHash, dependencies)) {
      await this.changed('modify', intent.path);
      throw new StaleIndexRevision();
    }
    const model=setting.embeddingModel||DEFAULT_GEMINI_EMBEDDING_MODEL;
    const configuration=this.configuration(setting);
    const fingerprint=await ragDigest(configuration);
    const embeddingSpace=await ragEmbeddingFingerprint(model,setting.embeddingBaseUrl);
    const oldSpace=await store.space();
    if(!rebuilding&&oldSpace&&oldSpace.fingerprint!==fingerprint)throw new Error('索引配置已变化，请强制重建整个索引');
    if(!intent.force&&!intent.newIdentity&&previous?.sourceHash===sourceHash&&previous.space.fingerprint===fingerprint&&JSON.stringify(previous.dependencies??{})===JSON.stringify(dependencies)&&await this.provenanceCurrent(file,previous,intent.setting)){await store.payload(previous);return null;}
    const document=await prepareDocumentInput(app,file,setting,control);
    const reusable=new Map<string,Float32Array>();
    if(!intent.force&&previous&&previous.space.fingerprint===fingerprint){
      const payload=await store.payload(previous);
      payload.chunks.forEach((chunk,index)=>reusable.set(chunk.inputHash,payload.vectors.subarray(index*previous.space.dimension,(index+1)*previous.space.dimension)));
    }
    let base=!rebuilding&&await store.consumesLegacyBase()?await this.host.base(intent.setting):null;
    if(base){
      let unshadowed=false;
      for(const path of new Set([...Object.keys(base.index.fileChecksums),...base.index.meta.map(chunk=>chunk.filePath)]))if(!await store.shadows(path)){unshadowed=true;break;}
      if(!unshadowed)base=null;
    }
    if(base&&base.index.meta.length&&!base.index.embeddingSpace)throw new Error('旧索引向量空间无法验证，请强制重建整个索引');
    if(base&&base.index.meta.length&&base.index.embeddingSpace!==embeddingSpace)throw new Error('旧索引配置不同，请强制重建整个索引');
    if(!rebuilding&&base&&Object.keys(base.index.fileChecksums).length&&(base.index.embeddingModel!==model||base.index.chunkSize!==setting.chunkSize||base.index.chunkOverlap!==setting.chunkOverlap))throw new Error('旧索引配置不同，请强制重建整个索引');
    if(!intent.force&&!previous&&base&&base.index.embeddingModel===model&&base.index.chunkSize===setting.chunkSize&&base.index.chunkOverlap===setting.chunkOverlap){
      for(let index=0;index<base.index.meta.length;index++){
        const chunk=base.index.meta[index];if(chunk.filePath!==(intent.oldPath??intent.path))continue;
        reusable.set(await ragDigest(chunk.text),base.vectors.subarray(index*base.index.dimension,(index+1)*base.index.dimension));
      }
    }
    const missing=document.chunks.map((chunk,index)=>({chunk,index})).filter(({chunk})=>!reusable.has(chunk.inputHash));
    const generated=missing.length?await this.embed(intent.setting,missing.map(({index})=>document.inputs[index]),control,!rebuilding && intent.priority === 0):[];
    if(generated.length!==missing.length)throw new Error('嵌入返回数量不完整');
    const dimension=generated[0]?.length??oldSpace?.dimension??previous?.space.dimension??base?.index.dimension??0;
    if(!rebuilding&&base&&base.index.meta.length&&dimension!==base.index.dimension)throw new Error('嵌入维度发生变化，请强制重建整个索引');
    const rows=new Map(missing.map(({index},position)=>[index,generated[position]]));
    const vectors=new Float32Array(document.chunks.length*dimension);
    document.chunks.forEach((chunk,index)=>{
      const row=rows.get(index)??reusable.get(chunk.inputHash);
      if(!row||row.length!==dimension||Array.from(row).some(value=>!Number.isFinite(value)))throw new Error('嵌入向量维度或数值无效');
      vectors.set(row,index*dimension);
    });
    return {path:intent.path,documentId:intent.newIdentity??(rebuilding?(previous?.id??(intent.oldPath?randomUUID():undefined)):undefined),aliases:intent.aliases??(intent.oldPath?[intent.oldPath]:undefined),sourceHash,dependencies,extractedHash:document.extractedHash,quality:document.quality,
      chunks:document.chunks,vectors,space:{model,fingerprint,dimension,embeddingSpace},
      stillCurrent:async()=>!this.stopped && !control.signal.aborted && !this.frozen.has(intent.path) && !this.editorText.has(intent.path)
        && this.pending.get(this.key(intent.setting,intent.path))?.version===version
        &&this.configuration(this.setting(intent.setting))===configuration
        &&JSON.stringify(await markdownDependencies(app,file))===JSON.stringify(dependencies)
        && app.vault.getAbstractFileByPath(intent.path)===file && await sourceFingerprint(app,file)===sourceHash};
  }
  private async embed(name:string,inputs:RagEmbeddingInput[],control:WorkControl,automatic:boolean):Promise<number[][]>{
    const work=this.embeddingTail.catch(()=>{}).then(async()=>{await control.checkpoint();return this.host.embed(name,inputs,control,automatic);});
    this.embeddingTail=work.then(()=>undefined,()=>undefined);
    let cancel!:()=>void;
    const aborted=new Promise<never>((_resolve,reject)=>{cancel=()=>reject(Object.assign(new Error('任务已取消'),{name:'AbortError'}));control.signal.addEventListener('abort',cancel,{once:true});if(control.signal.aborted)cancel();});
    try{return await Promise.race([work,aborted]);}finally{control.signal.removeEventListener('abort',cancel);}
  }
  private async provenanceCurrent(file: TFile, head: DocumentHead, name: string): Promise<boolean> {
    if(file.extension!=='md'||!file.path.includes('/_llmhub_generated/'))return true;
    const expected=readConvertedProvenance(file.path,await this.host.app.vault.read(file));
    if(!expected.originalFilePath)return true;
    const {chunks}=await getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),name).payload(head);
    return chunks.every(chunk=>chunk.originalFilePath===expected.originalFilePath&&chunk.pageLabel===expected.pageLabel);
  }
  async retry(name: string): Promise<void> {
    for(const [key,intent] of this.pending)if(intent.setting===name&&intent.error){const retry={...intent,error:undefined,version:++this.generation,priority:2};this.pending.set(key,retry);this.settingVersions.set(name,retry.version);await this.persist(key,retry);}
    this.refreshIdlePolicy();
  }
  async repair(name: string, paths: readonly string[], corrupt: readonly string[]): Promise<void> {
    this.setting(name);
    for(const path of new Set(paths)){
      if(this.matches(name,path))await this.updateNow(name,path,corrupt.includes(path));
      else await this.enqueue(name,path,'delete',false,true);
    }
    await this.flush();
  }
  async reconcile(name: string, control?: WorkControl, automatic = false): Promise<{embedded:number;skipped:number;removed:number;errors:string[]}> {
    this.setting(name);
    const empty={embedded:0,skipped:0,removed:0,errors:[] as string[]};
    if(this.blocked.has(name)){if(automatic)return empty;throw new Error('该索引正在重建，请等待或取消当前任务');}
    const store=getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),name);
    const files=this.host.app.vault.getFiles().filter(file=>this.matches(name,file.path));
    const paths=new Set(files.map(file=>file.path));
    const base=await this.host.base(name);
    const legacy=[];
    for(const path of Object.keys(base?.index.fileChecksums??{}))if(!await store.shadows(path))legacy.push(path);
    const indexed=new Set([...(await store.documents()).map(head=>head.path),...legacy]);
    const before={...(this.totals.get(name)??{embedded:0,skipped:0,removed:0})};
    const fingerprint=await ragDigest(this.configuration(this.setting(name)));
    let skipped=0;
    for(const path of indexed)if(!paths.has(path)){if(automatic&&this.blocked.has(name))return empty;await this.enqueue(name,path,'delete',false,!automatic);}
    for(const file of files){
      if(automatic&&this.blocked.has(name))return empty;
      await control?.checkpoint();if(this.stopped)throw new Error('索引服务已停止');
      const head=await store.head(file.path);
      const baselineChecksum = base?.index.fileChecksums[file.path];
      if (automatic && !head && baselineChecksum !== undefined && baselineChecksum === await legacyRagFileChecksum(this.host.app, file, control)) {
        skipped++;
        continue;
      }
      const revision=await readDocumentRevision(this.host.app,file);
      if(head&&head.space.fingerprint===fingerprint&&documentRevisionKey(head.sourceHash, head.dependencies)===revision.key
        &&await this.provenanceCurrent(file,head,name)){skipped++;continue;}
      const pending = this.pending.get(this.key(name, file.path));
      if (automatic && (pending?.revision === revision.key || (!head && !pending && revision.empty && !indexed.has(file.path)))) continue;
      if(automatic&&this.blocked.has(name))return empty;
      await this.enqueue(name,file.path,'update',false,!automatic,undefined,revision.key);
    }
    await this.flush();
    if(this.status(name).failed)throw new Error('部分笔记更新失败，请查看失败记录并重试');
    const after=this.totals.get(name)??before;
    return {embedded:after.embedded-before.embedded,skipped:skipped+after.skipped-before.skipped,removed:after.removed-before.removed,errors:[]};
  }
  /** Stage a replacement while the published index remains readable. Activate only if the input still matches. */
  async rebuild(name: string, control: WorkControl): Promise<void> {
    this.setting(name);
    if(this.blocked.has(name))throw new Error('该索引正在重建，请等待或取消当前任务');
    this.blocked.add(name);
    try {
    this.notify();
    if(this.running&&this.pending.get(this.running.key)?.setting===name)await this.working;
    // The queue generation limits which intents this rebuild can retire.
    const generation=this.generation;
    const settingVersion=this.settingVersions.get(name)??0;
    const configuration=this.configuration(this.setting(name));
    const store=getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),name);
    const files=this.host.app.vault.getFiles().filter(file=>this.matches(name,file.path));
    const heads:DocumentHead[]=[];
    const movedAway=new Set([...this.pending.values()].filter(intent=>intent.setting===name&&intent.oldPath&&intent.oldPath!==intent.path).map(intent=>intent.oldPath));
    for(const file of files){
      await control.checkpoint();
      const pending=this.pending.get(this.key(name,file.path));
      // Reusing a path after a move or delete must not reuse the former document identity.
      const intent:Intent={...pending,setting:name,path:file.path,operation:'update',force:true,version:generation,priority:2,
        newIdentity:pending?.newIdentity??((pending?.operation==='delete'&&!pending.oldPath)||movedAway.has(file.path)?randomUUID():undefined)};
      const input=await this.prepare(intent,control,true);
      if(input)heads.push(await store.stage(input));
      control.update('准备RAG分块',heads.length,files.length,file.path);
    }
    await store.activate(heads,async()=>{
      await control.checkpoint();
      if((this.settingVersions.get(name)??0)!==settingVersion||this.configuration(this.setting(name))!==configuration)return false;
      const current=this.host.app.vault.getFiles().filter(file=>this.matches(name,file.path));
      if(current.length!==heads.length)return false;
      for(const head of heads){
        const file=this.host.app.vault.getAbstractFileByPath(head.path);
        if(!(file instanceof TFile)||await sourceFingerprint(this.host.app,file)!==head.sourceHash
          ||JSON.stringify(await markdownDependencies(this.host.app,file))!==JSON.stringify(head.dependencies??{}))return false;
      }
      return true;
    });
    for(const [key,intent] of this.pending)if(intent.setting===name&&intent.version<=generation){
      await this.persistence.get(key);
      await this.removeIntentFiles(key,intent.version);
      if(this.pending.get(key)?.version===intent.version){this.pending.delete(key);this.finish(key,'updated');}
    }
    control.saved?.(name);
    } finally { this.blocked.delete(name);this.refreshIdlePolicy(); }
  }
  async check(name: string, control?: WorkControl): Promise<{missing:string[];unindexed:string[];changed:string[];legacy:string[];corrupt:string[];needsReview:string[]}> {
    this.setting(name);
    const report={missing:[] as string[],unindexed:[] as string[],changed:[] as string[],legacy:[] as string[],corrupt:[] as string[],needsReview:[] as string[]};
    const store=getRagDocumentStore(this.host.app.vault.adapter,this.host.workspace(),name),heads=await store.documents();
    const base=await this.host.base(name);
    const files=this.host.app.vault.getFiles().filter(file=>this.matches(name,file.path));
    const indexed=new Map(heads.map(head=>[head.path,head]));
    const legacy:string[]=[];
    for(const path of Object.keys(base?.index.fileChecksums??{}))if(!await store.shadows(path))legacy.push(path);
    const fingerprint=await ragDigest(this.configuration(this.setting(name)));
    for(const path of new Set([...indexed.keys(),...legacy]))if(!this.matches(name,path))report.missing.push(path);
    for(const [position,file] of files.entries()){
      await control?.checkpoint();
      const head=indexed.get(file.path);
      if(!head){(legacy.includes(file.path)?report.legacy:report.unindexed).push(file.path);continue;}
      if(head.quality?.status==='needs-review')report.needsReview.push(file.path+' · '+head.quality.warnings.join(' '));
      if(head.sourceHash!==await sourceFingerprint(this.host.app,file)||head.space.fingerprint!==fingerprint
        ||JSON.stringify(head.dependencies??{})!==JSON.stringify(await markdownDependencies(this.host.app,file)))report.changed.push(file.path);
      try{
        if(!await this.provenanceCurrent(file,head,name)&&!report.changed.includes(file.path))report.changed.push(file.path);
        await store.payload(head);
      }catch{report.corrupt.push(file.path);}
      control?.update('扫描RAG文档',position+1,files.length,file.path);
    }
    return report;
  }
  async cancel(name: string): Promise<void> {
    for(const [key,intent] of this.pending)if(intent.setting===name){const cancelled={...intent,version:++this.generation,error:'已取消，可手动重试'};this.pending.set(key,cancelled);this.settingVersions.set(name,cancelled.version);await this.persist(key,cancelled);this.finish(key,undefined,new Error(cancelled.error));}
    this.notify();
  }
  async forget(name: string): Promise<void> {
    await this.cancel(name);await this.flush();
    for(const [key,intent] of this.pending)if(intent.setting===name){
      await this.persistence.get(key);
      await this.removeIntentFiles(key,intent.version);
      this.pending.delete(key);
    }
    this.notify();
  }
  async renameSetting(oldName:string,newName:string):Promise<void>{
    for(const [key,intent] of [...this.pending])if(intent.setting===oldName){
      const next={...intent,setting:newName,version:++this.generation},nextKey=this.key(newName,intent.path);
      this.settingVersions.set(newName,next.version);
      this.pending.set(nextKey,next);await this.persist(nextKey,next);await this.removeIntentFiles(key,intent.version);this.pending.delete(key);
    }
    this.notify();this.schedule();
  }
  dispose(): void {this.stopped=true;if(this.timer)window.clearTimeout(this.timer);this.listeners.clear();for(const key of this.waiters.keys())this.finish(key,undefined,new Error('索引任务已停止，待更新记录已保留'));}
}
