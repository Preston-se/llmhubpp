
import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
const mocks = vi.hoisted(() => ({ embed: vi.fn(async () => [[1, 0]]) }));
vi.mock('./embeddingProvider', () => ({ generateEmbeddings: mocks.embed, generateGeminiNativeEmbeddings: mocks.embed, MULTIMODAL_EXTENSIONS: new Set(), MULTIMODAL_FILE_SIZE_LIMITS: {} }));
import { initLocalRagStore, resetLocalRagStore } from './localRagStore';
import { getRagDocumentStore, forgetRagDocumentStore } from './ragDocumentStore';
import { saveRagSnapshot, ragEmbeddingFingerprint } from './localRagStorage';
import { RagLifecycle } from './ragLifecycle';
import { memoryVault } from './testSupport/memoryVault';
import { DEFAULT_RAG_SETTING } from 'src/types';
function fixture() {
  const v = memoryVault(), files = new Map(['Notes/a.md', 'Notes/b.md'].map(path => [path, Object.assign(new TFile(), { path, extension: 'md' })]));
  v.app.vault.getAbstractFileByPath = (path: string) => files.get(path) ?? null;
  const S = { ...DEFAULT_RAG_SETTING, embeddingModel: 'test', embeddingBaseUrl: 'http://local', targetFolders: ['Notes'] };
  const settings = { S, Other: { ...S }, Combined: { ...S, sourceRagSettings: ['S', 'Other'] } };
  resetLocalRagStore(); const store = initLocalRagStore(); store.workspaceFolder = 'W';
  return { v, files, settings, store, docs: getRagDocumentStore(v.io as never, 'W', 'S') };
}
async function seed(f: ReturnType<typeof fixture>, verified=true) {
  await saveRagSnapshot(f.v.app, 'S', {meta: [{filePath: 'Notes/a.md', text: 'old text', chunkIndex: 0}, {filePath: 'Notes/b.md', text: 'sentinel text', chunkIndex: 0}], dimension: 2, fileChecksums: {'Notes/a.md': 'a', 'Notes/b.md': 'b'}, embeddingModel: 'test', ...(verified?{embeddingSpace:await ragEmbeddingFingerprint('test','http://local')}:{}), chunkSize: 800, chunkOverlap: 150}, new Float32Array([1, 0, 1, 0]), 'W');
  await f.store.load(f.v.app, Object.keys(f.settings), f.settings);
}
describe('document overlay query contracts', () => {
  it('preserves the prior segment fingerprint compatibility without accepting endpoint drift',async()=>{
    const f=fixture();f.v.app.vault.getFiles=()=>[...f.files.values()];f.v.app.vault.read=async()=> 'legacy segment text';
    const lifecycle=new RagLifecycle({app:f.v.app,settings:()=>f.settings,workspace:()=> 'W',managedDirectories:()=>[],base:async()=>null,
      embed:async(_name,inputs)=>inputs.map(()=>[1,0]),tasks:{run:async(_title,work)=>work({signal:new AbortController().signal,checkpoint:async()=>{},update(){}})} as never});
    await lifecycle.updateNow('S','Notes/a.md');lifecycle.dispose();
    for(const [path,text] of f.v.files)if(path.includes('/event-')&&typeof text==='string'){const event=JSON.parse(text);delete event.head.space.embeddingSpace;f.v.files.set(path,JSON.stringify(event));}
    forgetRagDocumentStore(f.v.io as never,'W','S');f.store.clearAll();await f.store.load(f.v.app,Object.keys(f.settings),f.settings);
    expect((await f.store.search('S','text','','test',6,'http://local'))[0].text).toBe('legacy segment text');
    mocks.embed.mockClear();f.settings.S.embeddingBaseUrl='http://different';await expect(f.store.search('S','text','','test',6,'http://different')).rejects.toThrow(/向量空间/);expect(mocks.embed).not.toHaveBeenCalled();
  });
  it('rejects endpoint drift on a verified paired snapshot while retaining source navigation',async()=>{
    const f=fixture();await seed(f);mocks.embed.mockClear();f.settings.S.embeddingBaseUrl='http://different';
    await expect(f.store.search('S','text','','test',6,'http://different')).rejects.toThrow(/向量空间/);expect(mocks.embed).not.toHaveBeenCalled();
    expect(await f.store.getStatus(f.v.app,'S')).toMatchObject({vectorSpaceStatus:'changed'});expect(await f.store.getAdjacentChunk(f.v.app,'S','Notes/a.md','old text','next')).toBeNull();
  });
  it.each(['S','Combined'])('rejects an endpoint change before embedding a vector query (%s)',async name=>{
    const f=fixture();f.v.app.vault.getFiles=()=>[...f.files.values()];f.v.app.vault.read=async()=> 'synthetic indexed text';
    const lifecycle=new RagLifecycle({app:f.v.app,settings:()=>f.settings,workspace:()=> 'W',managedDirectories:()=>[],base:async()=>null,
      embed:async(_name,inputs)=>inputs.map(()=>[1,0]),tasks:{run:async(_title,work)=>work({signal:new AbortController().signal,checkpoint:async()=>{},update(){}})} as never});
    await lifecycle.updateNow('S','Notes/a.md');lifecycle.dispose();await f.store.load(f.v.app,Object.keys(f.settings),f.settings);mocks.embed.mockClear();
    f.settings.S.embeddingBaseUrl='http://different';await expect(f.store.search(name,'text','','test',6,'http://different')).rejects.toThrow(/向量空间/);
    expect(mocks.embed).not.toHaveBeenCalled();expect((await f.store.keywordSearch(f.v.app,'S','text',6))[0].filePath).toBe('Notes/a.md');
  });
  it('keeps unknown legacy snapshots readable without silently claiming a verified vector space',async()=>{
    const f=fixture();await seed(f,false);const before=new Map(f.v.files);mocks.embed.mockClear();
    await expect(f.store.search('S','text','','test',6,'http://local')).rejects.toThrow(/无法验证.*强制重建/);
    expect(mocks.embed).not.toHaveBeenCalled();expect((await f.store.keywordSearch(f.v.app,'S','text',6))).toHaveLength(2);
    expect(await f.store.getStatus(f.v.app,'S')).toMatchObject({vectorSpaceStatus:'unverified'});expect(f.v.files).toEqual(before);
  });
  it('rechecks source visibility after a slower combined source completes',async()=>{
    const f=fixture();await seed(f);
    await saveRagSnapshot(f.v.app,'Other',{meta:[{filePath:'Notes/b.md',text:'second',chunkIndex:0}],dimension:2,fileChecksums:{'Notes/b.md':'b'},embeddingModel:'test',embeddingSpace:await ragEmbeddingFingerprint('test','http://local'),chunkSize:800,chunkOverlap:150},new Float32Array([1,0]),'W');f.store.clearAll();
    let release!:(value:number[][])=>void;
    mocks.embed.mockImplementationOnce(async()=>[[1,0]]).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const query=f.store.search('Combined','text','','test',6,'http://local');while(!release)await new Promise(resolve=>setImmediate(resolve));
    await f.docs.remove('Notes/a.md');release([[1,0]]);
    expect((await query).some(row=>row.filePath==='Notes/a.md')).toBe(false);
  });
  it('does not load every legacy vector buffer just to register configurations on startup',async()=>{
    const f=fixture();await seed(f);f.store.clearAll();const read=vi.spyOn(f.v.io,'readBinary');
    await f.store.load(f.v.app,Object.keys(f.settings),f.settings);expect(read).not.toHaveBeenCalled();
  });
  it('masks deleted legacy rows in vector, keyword, adjacent and combined queries after restart', async () => {
    const f = fixture(); await seed(f);
    f.docs.hide('Notes/a.md'); await f.docs.remove('Notes/a.md'); f.files.delete('Notes/a.md');
    forgetRagDocumentStore(f.v.io as never, 'W', 'S'); f.store.clearAll();
    const vector = await f.store.search('Combined', 'text', '', 'test', 6, 'http://local');
    expect(vector.map(r => r.filePath)).toEqual(['Notes/b.md']);
    expect((await f.store.keywordSearch(f.v.app, 'Combined', 'text', 6)).map(r => r.filePath)).toEqual(['Notes/b.md']);
    expect(await f.store.getAdjacentChunk(f.v.app, 'Combined', 'Notes/a.md', 'old text', 'next')).toBeNull();
  });
  it('immediately excludes a now-out-of-scope baseline path even with automatic updates disabled', async () => {
    const f = fixture(); await seed(f);
    f.settings.S.targetFolders = ['Elsewhere'];
    expect(await f.store.search('S', 'text', '', 'test', 6, 'http://local')).toEqual([]);
    expect(await f.store.keywordSearch(f.v.app, 'S', 'text', 6)).toEqual([]);
  });
  it('rejects a combined index with identical model and dimensions but different embedding endpoints', async () => {
    const f = fixture(); await seed(f);
    f.settings.Other.embeddingBaseUrl = 'http://different';
    await saveRagSnapshot(f.v.app, 'Other', {meta: [{filePath: 'Notes/b.md', text: 'other', chunkIndex: 0}], dimension: 2, fileChecksums: {'Notes/b.md': 'b'}, embeddingModel: 'test', chunkSize: 800, chunkOverlap: 150}, new Float32Array([1, 0]), 'W');
    f.store.clearAll();
    await expect(f.store.search('Combined', 'text', '', 'test', 6, 'http://local')).rejects.toThrow(/向量空间/);
  });
  it('rejects an indirect combined-index cycle without overflowing the stack', async () => {
    const f = fixture(); f.settings.S.sourceRagSettings = ['Combined'];
    await expect(f.store.load(f.v.app, Object.keys(f.settings), f.settings)).resolves.toBeUndefined();
    await expect(f.store.getStatus(f.v.app, 'Combined')).rejects.toThrow(/循环/);
  });
});
