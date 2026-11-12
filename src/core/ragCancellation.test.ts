import {describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({embed:vi.fn()}));
vi.mock('./embeddingProvider',()=>({generateEmbeddings:(...args:any[])=>state.embed(...args),generateGeminiNativeEmbeddings:vi.fn(),MULTIMODAL_EXTENSIONS:new Set(),MULTIMODAL_FILE_SIZE_LIMITS:{}}));
import {initLocalRagStore,resetLocalRagStore} from './localRagStore';
import {TaskManager} from './taskManager';
import {ragEmbeddingFingerprint} from './localRagStorage';
describe('index cancellation integrity',()=>{
 it.each(['embedding','commit'])('does not replace the old index or vectors when a changed document is cancelled',async(point)=>{
  resetLocalRagStore();const store=initLocalRagStore();const task=new TaskManager().create('RAG');
  const old={meta:[{filePath:'notes/book.md',chunkIndex:0,text:'old'}],dimension:2,fileChecksums:{'notes/book.md':'old'},embeddingModel:'model',embeddingSpace:await ragEmbeddingFingerprint('model','http://local'),chunkSize:800,chunkOverlap:150,pdfChunkPages:6,indexMultimodal:false};
  const writes=vi.fn();
  const app:any={vault:{getFiles:()=>[{path:'notes/book.md',extension:'md'}],read:async()=> 'new text',adapter:{exists:async()=>true,read:async()=>JSON.stringify(old),readBinary:async()=>new Float32Array([1,2]).buffer,write:writes,writeBinary:writes}}};
  state.embed.mockImplementation(async(...args:any[])=>{if(point==='embedding')task.cancel();await args[6]?.checkpoint();return [[3,4]];});
  if(point==='commit'){const update=task.update.bind(task);task.update=(...args)=>{update(...args);if(args[0]==='保存RAG索引')task.cancel();};}
  await expect(store.sync(app,'Test','','model',800,150,6,{includeFolders:['notes'],excludePatterns:[]},undefined,'http://local',false,undefined,undefined,task)).rejects.toMatchObject({name:'AbortError'});
  expect(writes).not.toHaveBeenCalled();
  expect((await store.getStatus(app,'Test')).chunkCount).toBe(1);
  resetLocalRagStore();
 });
});
