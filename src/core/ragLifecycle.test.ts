import { afterEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { memoryVault } from './testSupport/memoryVault';
import { DEFAULT_RAG_SETTING } from 'src/types';
import { RagLifecycle } from './ragLifecycle';
import { getRagDocumentStore, forgetRagDocumentStore } from './ragDocumentStore';
import type { LocalRagIndex } from './localRagStorage';
import { ragDigest } from './localRagStorage';
import { TaskManager } from './taskManager';
const control = { signal: new AbortController().signal, checkpoint: async () => {}, update() {} };
function fixture(debounceMs: number | null = 0, idleSeconds?: () => number, canRunAutomatic?: (name: string) => boolean, manager?: TaskManager) {
  const memory = memoryVault();
  const files = new Map<string, TFile>();
  const set = (path: string, content: string) => { memory.files.set(path, content); files.set(path, Object.assign(new TFile(), {path,extension:'md',stat:{mtime:Date.now(),size:content.length}})); };
  const app = memory.app as any;
  app.vault.getAbstractFileByPath = (path: string) => files.get(path) ?? null;
  app.vault.getFiles = vi.fn(() => [...files.values()]);
  app.vault.read = async (file: TFile) => memory.io.read(file.path);
  const embed = vi.fn(async (_name: string, texts: string[]) => texts.map(() => [1,0]));
  const settings = { S: {...DEFAULT_RAG_SETTING,autoUpdateIndex:true,embeddingModel:'test',embeddingBaseUrl:'http://localhost:1',chunkSize:25,chunkOverlap:0,targetFolders:['Notes']} };
  const base=vi.fn(async()=>null as {index:LocalRagIndex;vectors:Float32Array}|null);
  const make = () => new RagLifecycle({app,settings:()=>settings,workspace:()=> 'W',managedDirectories:()=>['W'],base,embed,
    tasks:manager ?? {run:async(_title: string, work: any)=>work(control)} as never, idleSeconds, canRunAutomatic}, debounceMs === null ? {} : { debounceMs });
  const lifecycle = make();
  return { memory,app,files,set,embed,base,settings,lifecycle,make,store:getRagDocumentStore(memory.io as never,'W','S') };
}
afterEach(() => vi.useRealTimers());

describe('RAG per-note idle policy', () => {
  it('publishes through the real task manager using its work control', async () => {
    const f = fixture(0, undefined, undefined, new TaskManager());
    f.set('Notes/a.md', 'fixture for the task controller');
    await expect(f.lifecycle.updateNow('S', 'Notes/a.md')).resolves.toBe('updated');
    expect((await f.store.head('Notes/a.md'))?.sourceHash).toBe(await ragDigest('fixture for the task controller'));
    f.lifecycle.dispose();
  });
  it('waits 600 seconds per saved note, independent of identical writes and a later save to a second note', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    const f = fixture(null);
    f.set('Notes/a.md', 'alpha');
    await f.lifecycle.changed('create', 'Notes/a.md');
    await vi.advanceTimersByTimeAsync(120_000);
    f.set('Notes/b.md', 'beta');
    await f.lifecycle.changed('create', 'Notes/b.md');
    await vi.advanceTimersByTimeAsync(479_999);
    await f.lifecycle.changed('modify', 'Notes/a.md');
    expect(f.embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await f.lifecycle.flush();
    expect(f.embed.mock.calls.map(([, inputs]) => inputs)).toEqual([['alpha']]);
    await vi.advanceTimersByTimeAsync(120_000);
    await f.lifecycle.flush();
    expect(f.embed.mock.calls.map(([, inputs]) => inputs)).toEqual([['alpha'], ['beta']]);
    f.lifecycle.dispose();
  });

  it('reports each saved note and index with its actual deadline before creating any managed task', async () => {
    const start = Date.UTC(2026, 10, 11);
    vi.useFakeTimers({ now: start });
    const manager = new TaskManager();
    const f = fixture(null, undefined, undefined, manager);
    Object.assign(f.settings, { T: { ...f.settings.S } });
    f.set('Notes/a.md', 'alpha');
    await f.lifecycle.changed('modify', 'Notes/a.md');
    await vi.advanceTimersByTimeAsync(120_000);
    f.set('Notes/b.md', 'beta');
    await f.lifecycle.changed('modify', 'Notes/b.md');

    expect(f.lifecycle.listPendingIndexTasks()).toEqual([
      { path: 'Notes/a.md', setting: 'S', operation: 'update', status: 'waiting', dueAt: start + 600_000 },
      { path: 'Notes/a.md', setting: 'T', operation: 'update', status: 'waiting', dueAt: start + 600_000 },
      { path: 'Notes/b.md', setting: 'S', operation: 'update', status: 'waiting', dueAt: start + 720_000 },
      { path: 'Notes/b.md', setting: 'T', operation: 'update', status: 'waiting', dueAt: start + 720_000 },
    ]);
    expect(manager.list()).toHaveLength(0);
    expect(f.embed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(start + 600_000);
    expect(f.lifecycle.listPendingIndexTasks().filter(task => task.status === 'queued').map(task => task.path))
      .toEqual(['Notes/a.md', 'Notes/a.md']);
    f.lifecycle.dispose();
  });

  it('publishes holds and deferrals without reporting an automatic deadline for them', async () => {
    const start = Date.UTC(2026, 10, 11);
    vi.useFakeTimers({ now: start });
    const f = fixture(null, undefined, name => name === 'S');
    Object.assign(f.settings, { T: { ...f.settings.S } });
    const snapshots: unknown[] = [];
    const stop = f.lifecycle.observe(() => { snapshots.push(f.lifecycle.listPendingIndexTasks()); });
    f.set('Notes/a.md', 'saved');
    await f.lifecycle.changed('modify', 'Notes/a.md');
    expect(snapshots.at(-1)).toEqual([
      { path: 'Notes/a.md', setting: 'S', operation: 'update', status: 'waiting', dueAt: start + 600_000 },
      { path: 'Notes/a.md', setting: 'T', operation: 'update', status: 'deferred' },
    ]);
    f.lifecycle.noteEditorChanged('Notes/a.md', 'editing');
    expect(snapshots.at(-1)).toEqual([
      { path: 'Notes/a.md', setting: 'S', operation: 'update', status: 'held', reason: 'save' },
      { path: 'Notes/a.md', setting: 'T', operation: 'update', status: 'deferred' },
    ]);
    f.lifecycle.releaseEditorChange('Notes/a.md');
    expect(snapshots.at(-1)).toEqual(expect.arrayContaining([expect.objectContaining({ setting: 'S', status: 'waiting' })]));
    f.lifecycle.freezeNoteUpdates(['Notes/a.md']);
    expect(snapshots.at(-1)).toEqual(expect.arrayContaining([expect.objectContaining({ setting: 'S', status: 'held', reason: 'choice' })]));
    await f.lifecycle.chooseNoteUpdates(['Notes/a.md'], 'remind');
    f.lifecycle.unfreezeNoteUpdates(['Notes/a.md']);
    expect(snapshots.at(-1)).toEqual([
      { path: 'Notes/a.md', setting: 'S', operation: 'update', status: 'deferred' },
      { path: 'Notes/a.md', setting: 'T', operation: 'update', status: 'deferred' },
    ]);
    expect(f.embed).not.toHaveBeenCalled();
    stop();
    f.lifecycle.dispose();
  });

  it('restores a failed index and a waiting index for the same note without running either', async () => {
    const start = Date.UTC(2026, 10, 11);
    vi.useFakeTimers({ now: start });
    const f = fixture(null);
    Object.assign(f.settings, { T: { ...f.settings.S } });
    f.set('Notes/a.md', 'alpha');
    await f.lifecycle.changed('modify', 'Notes/a.md');
    f.embed.mockRejectedValueOnce(new Error('offline'));
    await expect(f.lifecycle.updateNow('S', 'Notes/a.md')).rejects.toThrow('offline');
    await f.lifecycle.flush();
    f.lifecycle.dispose();

    const restarted = f.make();
    const snapshots: unknown[] = [];
    restarted.observe(() => { snapshots.push(restarted.listPendingIndexTasks()); });
    await restarted.initialize();
    expect(snapshots.at(-1)).toEqual(expect.arrayContaining([
      { path: 'Notes/a.md', setting: 'S', operation: 'update', status: 'failed', error: '索引更新失败；请检查嵌入服务或资料格式后重试' },
      { path: 'Notes/a.md', setting: 'T', operation: 'update', status: 'waiting', dueAt: start + 600_000 },
    ]));
    expect(f.embed).toHaveBeenCalledTimes(1);
    restarted.dispose();
  });

  it('does not release a new revision of A when an in-flight call or a manual B update completes', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    const f = fixture(null);
    f.set('Notes/a.md', 'old');
    await f.lifecycle.updateNow('S', 'Notes/a.md');
    f.embed.mockClear();
    let release!: (value: number[][]) => void;
    let started!: () => void;
    const startedCall = new Promise<void>(resolve => { started = resolve; });
    f.embed.mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
    f.set('Notes/a.md', 'first revision');
    await f.lifecycle.changed('modify', 'Notes/a.md');
    await vi.advanceTimersByTimeAsync(600_000);
    await startedCall;
    expect(f.lifecycle.listPendingIndexTasks()).toEqual([]);
    f.set('Notes/a.md', 'latest revision');
    await f.lifecycle.changed('modify', 'Notes/a.md');
    expect(f.lifecycle.listPendingIndexTasks()).toEqual([
      { path: 'Notes/a.md', setting: 'S', operation: 'update', status: 'waiting', dueAt: Date.now() + 600_000 },
    ]);
    f.set('Notes/b.md', 'manual beta');
    const manual = f.lifecycle.updateNow('S', 'Notes/b.md');
    release([[1, 0]]);
    await manual;
    expect(f.embed.mock.calls.map(([, inputs]) => inputs)).toEqual([['first revision'], ['manual beta']]);
    expect((await f.store.head('Notes/a.md'))?.sourceHash).toBe(await ragDigest('old'));
    await vi.advanceTimersByTimeAsync(600_000);
    await f.lifecycle.flush();
    expect((await f.store.head('Notes/a.md'))?.sourceHash).toBe(await ragDigest('latest revision'));
    f.lifecycle.dispose();
  });

  it('keeps blank new notes silent and clears old search results only after an edited note becomes idle', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    const f = fixture(null);
    f.set('Notes/a.md', 'old');
    await f.lifecycle.updateNow('S', 'Notes/a.md');
    f.embed.mockClear();
    f.set('Notes/a.md', '');
    f.set('Notes/blank.md', '   ');
    await Promise.all([f.lifecycle.changed('modify', 'Notes/a.md'), f.lifecycle.changed('create', 'Notes/blank.md')]);
    await vi.advanceTimersByTimeAsync(599_999);
    await f.lifecycle.flush();
    expect((await f.store.find([1, 0], 5)).map(item => item.text)).toEqual(['old']);
    await vi.advanceTimersByTimeAsync(1);
    await f.lifecycle.flush();
    expect(await f.store.find([1, 0], 5)).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
    f.lifecycle.dispose();
  });

  it('keeps 100 edits in one scheduler, using the same origin for both enabled indexes', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    const f = fixture(null);
    Object.assign(f.settings, { T: { ...f.settings.S }, Off: { ...f.settings.S, autoUpdateIndex: false } });
    const saves = Array.from({ length: 100 }, (_, index) => {
      const path = `Notes/note-${index}.md`;
      f.set(path, `note ${index}`);
      return f.lifecycle.changed('create', path);
    });
    await Promise.all(saves);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(f.embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await f.lifecycle.flush();
    expect(f.embed.mock.calls.filter(([name]) => name === 'S')).toHaveLength(100);
    expect(f.embed.mock.calls.filter(([name]) => name === 'T')).toHaveLength(100);
    expect(f.embed.mock.calls.filter(([name]) => name === 'Off')).toHaveLength(0);
    f.lifecycle.dispose();
  });

  it('waits for the editor save and recalculates queued times when the configured idle period changes', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    let seconds = 600;
    const f = fixture(null, () => seconds);
    f.set('Notes/a.md', 'saved');
    await f.lifecycle.changed('create', 'Notes/a.md');
    await vi.advanceTimersByTimeAsync(4_000);
    f.lifecycle.noteEditorChanged('Notes/a.md', 'editing');
    seconds = 5;
    f.lifecycle.refreshIdlePolicy();
    await vi.advanceTimersByTimeAsync(1_000);
    await f.lifecycle.flush();
    expect(f.embed).not.toHaveBeenCalled();
    f.set('Notes/a.md', 'editing');
    await f.lifecycle.changed('modify', 'Notes/a.md');
    await vi.advanceTimersByTimeAsync(5_000);
    await f.lifecycle.flush();
    expect(f.embed.mock.calls.map(([, inputs]) => inputs)).toEqual([['editing']]);
    f.lifecycle.dispose();
  });

  it('keeps a paused version and the previous index on disk, then consumes the reopen reminder once', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    const f = fixture(null);
    f.set('Notes/a.md', 'old');
    await f.lifecycle.updateNow('S', 'Notes/a.md');
    f.embed.mockClear();
    f.set('Notes/a.md', 'replacement');
    await f.lifecycle.changed('modify', 'Notes/a.md');
    expect(f.lifecycle.pendingNotePaths()).toEqual(['Notes/a.md']);
    f.lifecycle.freezeNoteUpdates(['Notes/a.md']);
    await vi.advanceTimersByTimeAsync(610_000);
    await f.lifecycle.flush();
    expect(f.embed).not.toHaveBeenCalled();
    await f.lifecycle.chooseNoteUpdates(['Notes/a.md'], 'remind');
    f.lifecycle.unfreezeNoteUpdates(['Notes/a.md']);
    f.lifecycle.dispose();
    const restarted = f.make();
    await restarted.initialize();
    await restarted.reconcile('S', undefined, true);
    expect(await restarted.getOpenReminder('Notes/a.md')).toBe(true);
    expect(await restarted.getOpenReminder('Notes/a.md')).toBe(false);
    await restarted.changed('modify', 'Notes/a.md');
    await vi.advanceTimersByTimeAsync(610_000);
    await restarted.flush();
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.store.find([1, 0], 5))[0]?.text).toBe('old');
    f.set('Notes/a.md', 'real new edit');
    await restarted.changed('modify', 'Notes/a.md');
    await vi.advanceTimersByTimeAsync(600_000);
    await restarted.flush();
    expect(f.embed.mock.calls.map(([, inputs]) => inputs)).toEqual([['real new edit']]);
    restarted.dispose();
  });
});

describe('RAG lifecycle', () => {
  it('keeps each child identity when directory rename callbacks overlap before the debounce',async()=>{
    const f=fixture(),ids=new Map<string,string>();
    for(const leaf of ['a.md','b.md']){f.set('Notes/A/'+leaf,leaf);await f.lifecycle.updateNow('S','Notes/A/'+leaf);ids.set(leaf,(await f.store.head('Notes/A/'+leaf))!.id);}
    await f.lifecycle.flush();f.embed.mockClear();
    for(const [from,to] of [['A','B'],['B','C']]){
      const changes:Promise<void>[]=[];
      for(const leaf of ids.keys()){f.files.delete(`Notes/${from}/${leaf}`);f.set(`Notes/${to}/${leaf}`,leaf);changes.push(f.lifecycle.changed('rename',`Notes/${to}/${leaf}`,`Notes/${from}/${leaf}`));}
      await Promise.all(changes);
    }
    await f.lifecycle.flush();for(const [leaf,id] of ids)expect(await f.store.resolve(id)).toBe('Notes/C/'+leaf);expect(f.embed).not.toHaveBeenCalled();f.lifecycle.dispose();
  });
  it('does not let a fully shadowed unknown snapshot block verified segment updates',async()=>{
    const f=fixture();f.set('Notes/a.md','current');await f.lifecycle.updateNow('S','Notes/a.md');await f.lifecycle.flush();
    f.base.mockResolvedValue({index:{meta:[{filePath:'Notes/a.md',chunkIndex:0,text:'old'}],dimension:2,fileChecksums:{'Notes/a.md':'old'},embeddingModel:'test',chunkSize:25,chunkOverlap:0},vectors:new Float32Array([1,0])});
    f.set('Notes/a.md','edited');await expect(f.lifecycle.updateNow('S','Notes/a.md')).resolves.toBe('updated');expect((await f.store.find([1,0],6))[0].text).toBe('edited');f.lifecycle.dispose();
  });
  it.each(['flush','rebuild'])('preserves the moved identity when replacing a deleted destination (%s)',async mode=>{
    const f=fixture();f.set('Notes/a.md','original');f.set('Notes/b.md','old target');await f.lifecycle.updateNow('S','Notes/a.md');await f.lifecycle.updateNow('S','Notes/b.md');await f.lifecycle.flush();
    const origin=(await f.store.head('Notes/a.md'))!,target=(await f.store.head('Notes/b.md'))!;
    f.files.delete('Notes/b.md');await f.lifecycle.changed('delete','Notes/b.md');f.files.delete('Notes/a.md');f.set('Notes/b.md','original');await f.lifecycle.changed('rename','Notes/b.md','Notes/a.md');
    if(mode==='flush')await f.lifecycle.flush();else await f.lifecycle.rebuild('S',control);
    expect(await f.store.resolve(origin.id)).toBe('Notes/b.md');expect(await f.store.resolve(target.id)).toBeNull();f.lifecycle.dispose();
  });
  it('restores a rename chain persisted by the pre-fix queue schema',async()=>{
    const f=fixture();f.set('Notes/a.md','original');await f.lifecycle.updateNow('S','Notes/a.md');await f.lifecycle.flush();const old=(await f.store.head('Notes/a.md'))!;
    f.files.delete('Notes/a.md');f.set('Notes/c.md','original');
    await f.lifecycle.changed('rename','Notes/b.md','Notes/a.md');
    // Historical queues stored one intent per destination and no chain metadata.
    const first=[...f.memory.files.entries()].find(([path])=>path.includes('/.pending-documents/')&&path.endsWith('.json'))!;
    const middle=JSON.parse(first[1] as string);delete middle.aliases;delete middle.supersedes;
    await f.lifecycle.changed('rename','Notes/c.md','Notes/b.md');
    const last=[...f.memory.files.entries()].find(([path])=>path.includes('/.pending-documents/')&&path.endsWith('.json'))!;
    const final=JSON.parse(last[1] as string);final.oldPath='Notes/b.md';delete final.aliases;delete final.supersedes;
    f.memory.files.set(first[0],JSON.stringify(middle));f.memory.files.set(last[0],JSON.stringify(final));f.lifecycle.dispose();forgetRagDocumentStore(f.memory.io as never,'W','S');
    const restarted=f.make();await restarted.initialize();await restarted.flush();expect(await getRagDocumentStore(f.memory.io as never,'W','S').resolve(old.id)).toBe('Notes/c.md');restarted.dispose();
  });
  it('repairs provenance on unchanged pre-fix segments without re-embedding',async()=>{
    const f=fixture(),path='Notes/_llmhub_generated/report/part-1.md',body='---\nllmhubpp_source: true\nsource_path: "Sources/report.pdf"\nsource_page: "pages 4-6 of 9"\n---\n\nConverted';
    f.set(path,body);await f.lifecycle.updateNow('S',path);await f.lifecycle.flush();const head=(await f.store.head(path))!;
    const payload=await f.store.payload(head);
    await f.store.update({path,sourceHash:await ragDigest(body),extractedHash:head.extractedHash,space:head.space,chunks:payload.chunks.map(({originalFilePath:_original,pageLabel:_page,...chunk})=>chunk),vectors:payload.vectors});
    f.embed.mockClear();expect((await f.lifecycle.check('S')).changed).toContain(path);
    await f.lifecycle.reconcile('S');expect((await f.store.find([1,0],100))[0]).toMatchObject({originalFilePath:'Sources/report.pdf',pageLabel:'pages 4-6 of 9'});expect(f.embed).not.toHaveBeenCalled();f.lifecycle.dispose();
  });
  it('keeps a new document at the old path independent of a later rename in the original chain',async()=>{
    const f=fixture();f.set('Notes/a.md','original');await f.lifecycle.updateNow('S','Notes/a.md');await f.lifecycle.flush();const old=(await f.store.head('Notes/a.md'))!;
    f.files.delete('Notes/a.md');f.set('Notes/b.md','original');await f.lifecycle.changed('rename','Notes/b.md','Notes/a.md');
    f.set('Notes/a.md','replacement');await f.lifecycle.changed('create','Notes/a.md');
    f.files.delete('Notes/b.md');f.set('Notes/c.md','original');await f.lifecycle.changed('rename','Notes/c.md','Notes/b.md');
    await f.lifecycle.updateNow('S','Notes/a.md');await f.lifecycle.flush();expect(await f.store.resolve(old.id)).toBe('Notes/c.md');expect((await f.store.head('Notes/a.md'))!.id).not.toBe(old.id);f.lifecycle.dispose();
  });
  it('retains converted PDF provenance on every incremental Markdown chunk',async()=>{
    const f=fixture(),path='Notes/_llmhub_generated/report/part-1.md';
    f.set(path,'---\nllmhubpp_source: true\nsource_path: "Sources/report.pdf"\nsource_page: "pages 4-6 of 9"\n---\n\nConverted paragraph with synthetic text.');
    await f.lifecycle.updateNow('S',path);const rows=await f.store.find([1,0],100);
    expect(rows.length).toBeGreaterThan(1);for(const row of rows)expect(row).toMatchObject({filePath:path,originalFilePath:'Sources/report.pdf',pageLabel:'pages 4-6 of 9'});f.lifecycle.dispose();
  });
  it('refuses to reuse unverified legacy vectors during a document update',async()=>{
    const f=fixture();f.set('Notes/a.md','old');f.base.mockResolvedValue({index:{meta:[{filePath:'Notes/a.md',chunkIndex:0,text:'old'}],dimension:2,fileChecksums:{'Notes/a.md':'old'},embeddingModel:'test',chunkSize:25,chunkOverlap:0},vectors:new Float32Array([1,0])});
    await expect(f.lifecycle.updateNow('S','Notes/a.md')).rejects.toThrow(/无法验证.*强制重建/);expect(await f.store.documents()).toEqual([]);f.lifecycle.dispose();
  });
  it.each(['same', 'replacement'])('keeps a deleted identity retired through force rebuild and restart (%s)', async text => {
    const f=fixture();f.set('Notes/a.md','same');await f.lifecycle.updateNow('S','Notes/a.md');const old=(await f.store.head('Notes/a.md'))!;
    f.files.delete('Notes/a.md');await f.lifecycle.changed('delete','Notes/a.md');f.set('Notes/a.md',text);await f.lifecycle.changed('create','Notes/a.md');
    await f.lifecycle.rebuild('S',control);expect(await f.store.resolve(old.id)).toBeNull();
    f.lifecycle.dispose();forgetRagDocumentStore(f.memory.io as never,'W','S');
    const restarted=f.make();await restarted.initialize();await restarted.flush();const docs=getRagDocumentStore(f.memory.io as never,'W','S');
    expect(await docs.resolve(old.id)).toBeNull();expect((await docs.find([1,0],6))[0].text).toBe(text);restarted.dispose();
  });
  it('keeps a pending replacement hidden when rebuild is cancelled and can retry after restart',async()=>{
    const f=fixture();f.set('Notes/a.md','old');await f.lifecycle.updateNow('S','Notes/a.md');const old=(await f.store.head('Notes/a.md'))!;
    await f.lifecycle.changed('delete','Notes/a.md');f.set('Notes/a.md','new');await f.lifecycle.changed('create','Notes/a.md');
    const abort=new AbortController();abort.abort();await expect(f.lifecycle.rebuild('S',{...control,signal:abort.signal,checkpoint:async()=>{throw new Error('任务已取消');}})).rejects.toThrow();
    expect(await f.store.resolve(old.id)).toBeNull();f.lifecycle.dispose();forgetRagDocumentStore(f.memory.io as never,'W','S');
    const restarted=f.make();await restarted.initialize();await restarted.flush();expect(await getRagDocumentStore(f.memory.io as never,'W','S').resolve(old.id)).toBeNull();restarted.dispose();
  });
  it.each(['flush','restart','rebuild','scope'])('preserves identity and vectors through a debounced rename chain (%s)',async mode=>{
    const f=fixture();f.set('Notes/a.md','same');await f.lifecycle.updateNow('S','Notes/a.md');const old=(await f.store.head('Notes/a.md'))!;f.embed.mockClear();
    const middle=mode==='scope'?'Outside/b.md':'Notes/sub/b.md';f.files.delete('Notes/a.md');f.set(middle,'same');await f.lifecycle.changed('rename',middle,'Notes/a.md');
    f.files.delete(middle);f.set('Notes/c.md','same');await f.lifecycle.changed('rename','Notes/c.md',middle);
    let lifecycle=f.lifecycle;if(mode==='restart'){lifecycle.dispose();forgetRagDocumentStore(f.memory.io as never,'W','S');lifecycle=f.make();await lifecycle.initialize();}
    if(mode==='rebuild')await lifecycle.rebuild('S',control);else await lifecycle.flush();
    const docs=getRagDocumentStore(f.memory.io as never,'W','S');expect(await docs.resolve(old.id)).toBe('Notes/c.md');expect((await docs.find([1,0],6))[0].filePath).toBe('Notes/c.md');
    if(mode!=='rebuild')expect(f.embed).not.toHaveBeenCalled();lifecycle.dispose();
  });
  it('refreshes a Markdown attachment dependency without embedding unchanged text or altering the image',async()=>{
    const f=fixture();f.set('Notes/image.png','');f.files.get('Notes/image.png')!.extension='png';f.memory.files.set('Notes/image.png',new Uint8Array([1,2]).buffer);
    f.app.vault.readBinary=(file:TFile)=>f.memory.io.readBinary(file.path);f.set('Notes/a.md','# Note\n![[Notes/image.png]]');await f.lifecycle.updateNow('S','Notes/a.md');
    const previous=(await f.store.head('Notes/a.md'))!;f.embed.mockClear();const replacement=new Uint8Array([3,4]).buffer;f.memory.files.set('Notes/image.png',replacement);
    await f.lifecycle.changed('modify','Notes/image.png');await f.lifecycle.flush();const current=(await f.store.head('Notes/a.md'))!;
    expect(current.id).toBe(previous.id);expect(current.dependencies).not.toEqual(previous.dependencies);expect(f.embed).not.toHaveBeenCalled();expect(f.memory.files.get('Notes/image.png')).toEqual(replacement);f.lifecycle.dispose();
  });
  it('keeps non-Markdown files outside the index unless the existing multimodal option permits them',()=>{
    const f=fixture();f.set('Notes/source.pdf','');f.files.get('Notes/source.pdf')!.extension='pdf';
    expect(f.lifecycle.targets('Notes/source.pdf')).toEqual([]);f.settings.S.indexMultimodal=true;expect(f.lifecycle.targets('Notes/source.pdf')).toEqual(['S']);
    f.set('Notes/source.docx','');f.files.get('Notes/source.docx')!.extension='docx';expect(f.lifecycle.targets('Notes/source.docx')).toEqual([]);f.lifecycle.dispose();
  });
  it('serializes embeddings across rebuild and another configuration without invalidating the rebuild',async()=>{
    const f=fixture();Object.assign(f.settings,{T:{...f.settings.S,targetFolders:['Elsewhere']}});f.set('Notes/a.md','rebuild');f.set('Elsewhere/b.md','parallel');
    let active=0,maximum=0,release!:()=>void;
    f.embed.mockImplementation((name,texts)=>{active++;maximum=Math.max(maximum,active);if(name==='S')return new Promise(resolve=>{release=()=>{active--;resolve(texts.map(()=>[1,0]));};});active--;return Promise.resolve(texts.map(()=>[1,0]));});
    const rebuilding=f.lifecycle.rebuild('S',control).then(()=>true,()=>false);while(!release)await new Promise(resolve=>setImmediate(resolve));
    const updating=f.lifecycle.updateNow('T','Elsewhere/b.md');await new Promise(resolve=>setImmediate(resolve));release();
    expect(await rebuilding).toBe(true);await updating;expect(maximum).toBe(1);f.lifecycle.dispose();
  });
  it('preserves event order when delete/create callbacks overlap across differently scoped configurations',async()=>{
    const f=fixture();f.settings.S.targetFolders=['Elsewhere'];Object.assign(f.settings,{T:{...f.settings.S,targetFolders:['Notes']}});
    f.set('Notes/a.md','same');await f.lifecycle.updateNow('T','Notes/a.md');const store=getRagDocumentStore(f.memory.io as never,'W','T'),old=(await store.head('Notes/a.md'))!;
    f.files.delete('Notes/a.md');f.memory.files.delete('Notes/a.md');const removing=f.lifecycle.changed('delete','Notes/a.md');
    f.set('Notes/a.md','same');const creating=f.lifecycle.changed('create','Notes/a.md');await Promise.all([removing,creating]);await f.lifecycle.flush();
    expect((await store.find([1,0],6))[0]?.text).toBe('same');expect((await store.head('Notes/a.md'))?.id).not.toBe(old.id);f.lifecycle.dispose();
  });
  it('ignores a retained incompatible legacy base after a force rebuild',async()=>{
    const f=fixture();f.set('Notes/a.md','new model');f.base.mockResolvedValue({index:{meta:[{filePath:'Notes/a.md',chunkIndex:0,text:'old'}],dimension:3,fileChecksums:{'Notes/a.md':'old'},embeddingModel:'old-model',chunkSize:25,chunkOverlap:0},vectors:new Float32Array([1,0,0])});
    await f.lifecycle.rebuild('S',control);f.base.mockClear();f.set('Notes/a.md','edited after rebuild');
    await expect(f.lifecycle.updateNow('S','Notes/a.md')).resolves.toBe('updated');expect(f.base).not.toHaveBeenCalled();f.lifecycle.dispose();
  });
  it.each([false,true])('gives a coalesced identical delete/recreate a new visible identity (restart=%s)',async(restart)=>{
    const f=fixture();f.set('Notes/a.md','identical');await f.lifecycle.updateNow('S','Notes/a.md');const old=(await f.store.head('Notes/a.md'))!;
    f.files.delete('Notes/a.md');f.memory.files.delete('Notes/a.md');await f.lifecycle.changed('delete','Notes/a.md');
    f.set('Notes/a.md','identical');await f.lifecycle.changed('create','Notes/a.md');
    const lifecycle=restart?(f.lifecycle.dispose(),f.make()):f.lifecycle;if(restart)await lifecycle.initialize();await lifecycle.flush();
    expect((await f.store.head('Notes/a.md'))!.id).not.toBe(old.id);expect(await f.store.resolve(old.id)).toBeNull();
    expect((await f.store.find([1,0],6))[0].text).toBe('identical');lifecycle.dispose();
  });
  it('publishes an empty note in an existing vector space without requesting an embedding',async()=>{
    const f=fixture();f.set('Notes/a.md','text');await f.lifecycle.updateNow('S','Notes/a.md');f.embed.mockClear();f.set('Notes/empty.md','');
    await expect(f.lifecycle.updateNow('S','Notes/empty.md')).resolves.toBe('updated');expect(f.embed).not.toHaveBeenCalled();f.lifecycle.dispose();
  });
  it('persists repeated edits on a native adapter that refuses to rename over an existing file',async()=>{
    const f=fixture(),rename=f.memory.io.rename;
    f.memory.io.rename=async(from,to)=>{if(f.memory.files.has(to))throw new Error('Destination file already exists!');return rename(from,to);};
    f.set('Notes/a.md','one');await f.lifecycle.changed('modify','Notes/a.md');
    f.set('Notes/a.md','two');await f.lifecycle.changed('modify','Notes/a.md');await f.lifecycle.flush();
    expect((await f.store.find([1,0],6))[0].text).toBe('two');f.lifecycle.dispose();
  });
  it('debounces ten saves, restores durable pending work and publishes only the final input', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) });
    const f=fixture(null);
    for(let index=0;index<10;index++){ f.set('Notes/a.md','version '+index); await f.lifecycle.changed('modify','Notes/a.md'); }
    expect(f.embed).not.toHaveBeenCalled(); f.lifecycle.dispose();
    const restarted=f.make(); await restarted.initialize(); await vi.advanceTimersByTimeAsync(600_000); await restarted.flush();
    expect(f.embed.mock.calls.flatMap(call=>call[1])).toEqual(['version 9']);
    expect(restarted.status('S').pending).toBe(0); restarted.dispose();
  });
  it('keeps failures retryable without persisting service response secrets', async () => {
    const f=fixture();f.set('Notes/a.md','text');f.embed.mockRejectedValueOnce(new Error('HTTP 500 Bearer SECRET_KEY private text'));
    await expect(f.lifecycle.updateNow('S','Notes/a.md')).rejects.toThrow();
    expect([...f.memory.files.values()].filter(value=>typeof value==='string').join('')).not.toContain('SECRET_KEY');
    f.lifecycle.dispose();const restarted=f.make();await restarted.initialize();await restarted.flush();
    expect(restarted.status('S').failed).toBe(1);await restarted.retry('S');await restarted.flush();
    expect(restarted.status('S').failed).toBe(0);restarted.dispose();
  });
  it('detects changed embedding configuration during a consistency check', async () => {
    const f=fixture();f.set('Notes/a.md','text');await f.lifecycle.updateNow('S','Notes/a.md');
    f.settings.S.embeddingBaseUrl='http://another';
    expect((await f.lifecycle.check('S')).changed).toContain('Notes/a.md');f.lifecycle.dispose();
  });
  it('rebuilds atomically and clears the old failed intent only after publication', async () => {
    const f=fixture();f.set('Notes/a.md','old');await f.lifecycle.updateNow('S','Notes/a.md');
    f.set('Notes/a.md','new');f.embed.mockRejectedValueOnce(new Error('offline'));
    await expect(f.lifecycle.updateNow('S','Notes/a.md')).rejects.toThrow();
    await f.lifecycle.rebuild('S',control);
    expect(f.lifecycle.status('S').failed).toBe(0);
    expect((await f.store.find([1,0],6))[0].text).toBe('new');f.lifecycle.dispose();
  });
  it('updates only changed inputs and skips an unchanged manual request', async () => {
    const f=fixture();f.set('Notes/a.md','第一段内容。'.repeat(6));
    await f.lifecycle.updateNow('S','Notes/a.md');
    f.embed.mockClear();f.app.vault.getFiles.mockClear();
    expect(await f.lifecycle.updateNow('S','Notes/a.md')).toBe('current');
    expect(f.embed).not.toHaveBeenCalled();
    f.set('Notes/a.md','第一段内容。'.repeat(5)+' changed');
    await f.lifecycle.updateNow('S','Notes/a.md');
    expect(f.embed.mock.calls.flatMap(call=>call[1]).length).toBeLessThan(2);
    expect(f.app.vault.getFiles).not.toHaveBeenCalled();
    f.lifecycle.dispose();
  });
  it('reuses moved vectors, then durably removes a document moved outside scope', async () => {
    const f=fixture();f.set('Notes/a.md','text');
    await f.lifecycle.updateNow('S','Notes/a.md');f.embed.mockClear();
    f.files.delete('Notes/a.md');f.set('Notes/moved.md','text');
    await f.lifecycle.changed('rename','Notes/moved.md','Notes/a.md');await f.lifecycle.flush();
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.store.documents())[0].path).toBe('Notes/moved.md');
    f.files.delete('Notes/moved.md');f.set('Outside/moved.md','text');
    await f.lifecycle.changed('rename','Outside/moved.md','Notes/moved.md');await f.lifecycle.flush();
    expect(await f.store.find([1,0],6)).toEqual([]);
    f.lifecycle.dispose();
  });
  it('never publishes a stale in-flight embedding after deletion and can retry after restart', async () => {
    const f=fixture();f.set('Notes/a.md','old');
    await f.lifecycle.updateNow('S','Notes/a.md');
    let release!: (value:number[][])=>void;
    f.embed.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    f.set('Notes/a.md','new');
    const updating=f.lifecycle.updateNow('S','Notes/a.md').catch(()=>undefined);
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    f.files.delete('Notes/a.md');f.memory.files.delete('Notes/a.md');
    await f.lifecycle.changed('delete','Notes/a.md');release([[1,0]]);
    await updating;await f.lifecycle.flush();
    expect(await f.store.find([1,0],6)).toEqual([]);
    f.lifecycle.dispose();
  });
  it('forces new embeddings even when content is unchanged and persists failed work for retry', async () => {
    const f=fixture();f.set('Notes/a.md','text');
    await f.lifecycle.updateNow('S','Notes/a.md');f.embed.mockClear();
    await f.lifecycle.updateNow('S','Notes/a.md',true);
    expect(f.embed).toHaveBeenCalledTimes(1);
    f.set('Notes/a.md','changed');f.embed.mockRejectedValueOnce(new Error('offline'));
    await expect(f.lifecycle.updateNow('S','Notes/a.md')).rejects.toThrow();
    expect(f.lifecycle.status('S').failed).toBe(1);
    await f.lifecycle.retry('S');await f.lifecycle.flush();
    expect(f.lifecycle.status('S').failed).toBe(0);
    f.lifecycle.dispose();
  });
});
