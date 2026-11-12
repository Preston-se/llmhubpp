import {describe,it,expect} from 'vitest';import http from 'node:http';import {createRequire} from 'node:module';import {generateEmbeddings} from './embeddingProvider';import {TaskManager} from './taskManager';import {DiskEmbeddingBatchCache} from './embeddingCache';import {memoryVault} from './testSupport/memoryVault';
Object.assign(window,{require:createRequire(import.meta.url)});
describe('durable embedding batches',()=>{
 it('refuses dimension changes across otherwise valid batches',async()=>{
  let call=0;const server=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{const input=JSON.parse(b).input,dim=[2,1,3][call++];res.end(JSON.stringify({data:input.map(()=>({embedding:Array(dim).fill(1)}))}));});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{await expect(generateEmbeddings(Array(96).fill('input'),'','m',`http://127.0.0.1:${(server.address() as any).port}`,undefined,undefined,new TaskManager().create('dimension'))).rejects.toThrow(/维度/);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 });
 it('clears committed batch vectors without touching unrelated files',async()=>{
  const v=memoryVault(),cache=new DiskEmbeddingBatchCache(v.io as any,'cache','config');await cache.save('key',[[1,2]]);v.files.set('cache/user-note.md','keep');await cache.clear();expect(await cache.load('key',1)).toBe(null);expect(v.files.get('cache/user-note.md')).toBe('keep');
 });
 it('rejects malformed vectors and ignores corrupt or differently configured caches',async()=>{
  const v=memoryVault(),cache=new DiskEmbeddingBatchCache(v.io as any,'cache','config-a');
  await expect(cache.save('key',[[1,2],[3]])).rejects.toThrow();await cache.save('key',[[1,2]]);expect(await cache.load('key',1)).toEqual([[1,2]]);
  expect(await new DiskEmbeddingBatchCache(v.io as any,'cache','config-b').load('key',1)).toBe(null);
  const file=[...v.files.keys()].find(p=>p.endsWith('.json'))!;const data=JSON.parse(v.files.get(file) as string);data.rows=[[99,99]];v.files.set(file,JSON.stringify(data));expect(await cache.load('key',1)).toBe(null);
 });
 it('reuses the completed batch after interruption and invalidates changed inputs/model',async()=>{
  const v=memoryVault(),calls:number[]=[];const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{const p=JSON.parse(body);calls.push(p.input.length);res.end(JSON.stringify({data:p.input.map(()=>({embedding:[1,2]}))}));});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const url=`http://127.0.0.1:${(server.address() as any).port}`,texts=Array.from({length:35},(_,i)=>'chunk'+i);const task=new TaskManager().create('first');task.batchCache=new DiskEmbeddingBatchCache(v.io as any,'cache','document-config');const update=task.update.bind(task);task.update=(...args)=>{update(...args);if(args[1]===32)task.cancel();};
   await expect(generateEmbeddings(texts,'','model',url,undefined,undefined,task)).rejects.toMatchObject({name:'AbortError'});
   const resumed=new TaskManager().create('resume');resumed.batchCache=new DiskEmbeddingBatchCache(v.io as any,'cache','document-config');expect(await generateEmbeddings(texts,'','model',url,undefined,undefined,resumed)).toHaveLength(35);expect(calls).toEqual([32,3]);
   await generateEmbeddings(texts,'','different',url,undefined,undefined,resumed);expect(calls).toEqual([32,3,32,3]);texts[0]='changed';await generateEmbeddings(texts,'','model',url,undefined,undefined,resumed);expect(calls).toEqual([32,3,32,3,32]);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 });
});
