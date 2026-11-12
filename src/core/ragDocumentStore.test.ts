import { describe, expect, it, vi } from 'vitest';
import { memoryVault } from './testSupport/memoryVault';
import { RagDocumentStore } from './ragDocumentStore';
import { renameRagIndex, saveRagSnapshot, loadRagSnapshot } from './localRagStorage';
const space = { model: 'model', fingerprint: 'same-space', dimension: 2 };
const chunk = (text: string, index = 0) => ({ text, chunkIndex: index, inputHash: text, startOffset: index * 20 });
async function put(store: RagDocumentStore, path: string, text: string, vectors = [1, 0]) {
  return store.update({ path, sourceHash: text, extractedHash: text, space, chunks: [chunk(text)], vectors: new Float32Array(vectors) });
}
describe('document segments', () => {
  it('replays publication order across clock rollback, restart and compaction',async()=>{
    const v=memoryVault();let store=new RagDocumentStore(v.io as never,'W/docs');const clock=vi.spyOn(Date,'now');
    try{
      clock.mockReturnValue(2000000000000);const first=await put(store,'a.md','old');
      clock.mockReturnValue(1000000000000);await put(store,'a.md','new');
      store=new RagDocumentStore(v.io as never,'W/docs');expect((await store.find([1,0],6))[0].text).toBe('new');expect(await store.resolve(first.id)).toBe('a.md');
      clock.mockReturnValue(500000000000);await store.compact();store=new RagDocumentStore(v.io as never,'W/docs');
      clock.mockReturnValue(100000000000);await store.remove('a.md');store=new RagDocumentStore(v.io as never,'W/docs');expect(await store.find([1,0],6)).toEqual([]);expect(await store.resolve(first.id)).toBeNull();
    }finally{clock.mockRestore();}
  });
  it('loads legacy events before publishing sequenced replacements under an older clock',async()=>{
    const v=memoryVault();let store=new RagDocumentStore(v.io as never,'W/docs');await put(store,'a.md','legacy');
    for(const [path,text] of v.files)if(path.includes('/event-')&&typeof text==='string'){const event=JSON.parse(text);delete event.sequence;v.files.set(path,JSON.stringify(event));}
    store=new RagDocumentStore(v.io as never,'W/docs');const clock=vi.spyOn(Date,'now').mockReturnValue(1);
    try{await put(store,'a.md','migrated');expect((await new RagDocumentStore(v.io as never,'W/docs').find([1,0],6))[0].text).toBe('migrated');}finally{clock.mockRestore();}
  });
  it.each([false,true])('preserves segment heads and tombstones when a setting is renamed (legacy=%s)',async(legacy)=>{
    const v=memoryVault(),store=new RagDocumentStore(v.io as never,'W/rag/Old/.documents');
    if(legacy)await saveRagSnapshot(v.app,'Old',{meta:[{filePath:'deleted.md',text:'must not revive',chunkIndex:0}],dimension:2,fileChecksums:{'deleted.md':'hash'},embeddingModel:'model',chunkSize:1,chunkOverlap:0},new Float32Array([1,0]),'W');
    const head=await put(store,'a.md','live');await store.remove('deleted.md');
    await renameRagIndex(v.app,'Old','New','W');
    const renamed=new RagDocumentStore(v.io as never,'W/rag/New/.documents'),base=await loadRagSnapshot(v.app,'New','W');
    expect((await renamed.find([1,0],6,base)).map(row=>row.text)).toEqual(['live']);expect(await renamed.resolve(head.id)).toBe('a.md');
    expect([...v.files.keys()].some(path=>path.startsWith('W/rag/Old/'))).toBe(false);
  });
  it('changes one document without rewriting or reading unrelated vectors', async () => {
    const v = memoryVault(), store = new RagDocumentStore(v.io as never, 'W/docs');
    await put(store, 'a.md', 'old'); await put(store, 'b.md', 'untouched', [0, 1]);
    const before = new Map(v.files);
    const b=await store.head('b.md');
    const read = vi.spyOn(v.io, 'readBinary');
    await put(store, 'a.md', 'new');
    expect(read.mock.calls.some(([path])=>path===b!.vectors)).toBe(false);
    for (const [path, bytes] of before) expect(v.files.get(path), path).toEqual(bytes);
    const rows = await store.find([1, 1], 6);
    expect(rows.map(row => row.text)).toEqual(expect.arrayContaining(['new', 'untouched']));
    expect(rows.map(row => row.text)).not.toContain('old');
  });
  it('compacts immutable records without reviving legacy deletions or hiding untouched legacy rows', async () => {
    const v=memoryVault(),store=new RagDocumentStore(v.io as never,'W/docs');
    await put(store,'a.md','old');await put(store,'a.md','new');await store.remove('deleted.md');
    await store.compact();
    const restored=new RagDocumentStore(v.io as never,'W/docs');
    const base={index:{meta:[{filePath:'deleted.md',text:'deleted',chunkIndex:0},{filePath:'b.md',text:'baseline',chunkIndex:0}],dimension:2,fileChecksums:{},embeddingModel:'model',chunkSize:1,chunkOverlap:0},vectors:new Float32Array([1,0,1,0])};
    expect((await restored.find([1,0],6,base)).map(row=>row.text)).toEqual(['baseline','new']);
    expect([...v.files.keys()].filter(path=>path.includes('/event-'))).toHaveLength(1);
  });
  it('durably hides deleted paths and assigns a new identity to a recreated path', async () => {
    const v = memoryVault(), store = new RagDocumentStore(v.io as never, 'W/docs');
    const first = await put(store, 'a.md', 'old');
    store.hide('a.md'); await store.remove('a.md');
    const reloaded = new RagDocumentStore(v.io as never, 'W/docs');
    expect(await reloaded.find([1, 0], 6)).toEqual([]);
    const second = await put(reloaded, 'a.md', 'new');
    expect(second.id).not.toBe(first.id);
  });
  it('retains the old generation on incomplete vector publication and rejects incompatible spaces', async () => {
    const v = memoryVault(), store = new RagDocumentStore(v.io as never, 'W/docs');
    await put(store, 'a.md', 'old'); v.fail('vectors-');
    await expect(put(store, 'a.md', 'new')).rejects.toThrow();
    v.fail('');
    expect((await new RagDocumentStore(v.io as never, 'W/docs').find([1, 0], 6))[0].text).toBe('old');
    await expect(store.update({path:'b.md',sourceHash:'b',extractedHash:'b',space:{...space,fingerprint:'other-model'},chunks:[chunk('b')],vectors:new Float32Array([1,0])})).rejects.toThrow();
  });
  it('renames metadata with stable identity and filters an in-flight result after deletion', async () => {
    const v = memoryVault(), store = new RagDocumentStore(v.io as never, 'W/docs');
    const first = await put(store, 'a.md', 'text');
    await store.rename('a.md', 'moved.md');
    expect((await store.documents())[0]).toMatchObject({id:first.id,path:'moved.md'});
    expect((await store.find([1,0],6))[0].filePath).toBe('moved.md');
    store.hide('moved.md');
    expect(await store.find([1,0],6)).toEqual([]);
  });
});
