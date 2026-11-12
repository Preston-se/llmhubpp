import {describe,it,expect,vi} from 'vitest';
const stub=vi.hoisted(()=>({embed:vi.fn()}));vi.mock('./embeddingProvider',()=>({generateEmbeddings:(...a:any[])=>stub.embed(...a),generateGeminiNativeEmbeddings:vi.fn(),MULTIMODAL_EXTENSIONS:new Set(),MULTIMODAL_FILE_SIZE_LIMITS:{}}));
import {initLocalRagStore,resetLocalRagStore} from './localRagStore';import {TaskManager} from './taskManager';import {loadRagSnapshot} from './localRagStorage';import {memoryVault} from './testSupport/memoryVault';
describe('ordered incremental RAG commits',()=>{
 it('advances past empty documents without requesting embeddings or repeating the first batch forever',async()=>{
  const v=memoryVault();v.app.vault.getFiles=()=>Array.from({length:51},(_,i)=>({path:'notes/empty-'+i+'.md',extension:'md'})) as any;v.app.vault.read=async()=>'';stub.embed.mockClear();resetLocalRagStore();const store=initLocalRagStore();const sync=()=>store.sync(v.app,'S','','m',800,150,6,{includeFolders:['notes'],excludePatterns:[]},undefined,'http://local',false);expect((await sync()).deferredFiles).toBe(1);expect((await sync()).deferredFiles).toBe(0);expect(stub.embed).not.toHaveBeenCalled();expect(Object.keys((await loadRagSnapshot(v.app,'S','LLMHub'))!.index.fileChecksums)).toHaveLength(51);resetLocalRagStore();
 });
 it('commits part1 before starting part2, survives cancellation and resumes without re-embedding part1',async()=>{
  const v=memoryVault(),seen:string[]=[];const files=['part-10.md','part-2.md','part-1.md'].map(path=>({path:'notes/'+path,extension:'md'}));v.app.vault.getFiles=()=>files;v.app.vault.read=async(f:any)=>f.path;
  resetLocalRagStore();const store=initLocalRagStore(),task=new TaskManager().create('test');
  stub.embed.mockImplementation(async(texts:string[])=>{seen.push(texts[0]);if(seen.length===2){expect((await loadRagSnapshot(v.app,'S','LLMHub'))?.index.meta[0].filePath).toBe('notes/part-1.md');task.cancel();throw Object.assign(Error('cancel'),{name:'AbortError'});}return [[1,2]];});
  const sync=(control:any)=>store.sync(v.app,'S','','m',800,150,6,{includeFolders:['notes'],excludePatterns:[]},undefined,'http://local',false,undefined,undefined,control);
  await expect(sync(task)).rejects.toMatchObject({name:'AbortError'});expect(seen).toEqual(['notes/part-1.md','notes/part-2.md']);
  seen.length=0;stub.embed.mockImplementation(async(texts:string[])=>{seen.push(texts[0]);return [[1,2]];});await sync(new TaskManager().create('resume'));
  expect(seen).toEqual(['notes/part-2.md','notes/part-10.md']);expect((await loadRagSnapshot(v.app,'S','LLMHub'))?.index.meta).toHaveLength(3);resetLocalRagStore();
 });
});
