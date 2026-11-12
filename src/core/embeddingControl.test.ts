import {describe,it,expect,vi} from 'vitest';
import http from 'node:http';
import {generateEmbeddings} from './embeddingProvider';
import {TaskManager} from './taskManager';
import {createRequire} from 'node:module';
Object.assign(window,{require:createRequire(import.meta.url)});
describe('embedding request controls',()=>{
 it('aborts an active request instead of waiting for the server',async()=>{
  const task=new TaskManager().create('test');let disconnected=false;
  const server=http.createServer((req,res)=>{res.on('close',()=>{disconnected=true;});setTimeout(()=>{if(!res.destroyed)res.end(JSON.stringify({data:[{embedding:[1,2]}]}));},150);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
   const port=(server.address() as any).port;const pending=generateEmbeddings(['正文'],'','model',`http://127.0.0.1:${port}`,undefined,undefined,task);
   setTimeout(()=>task.cancel(),25);
   await expect(pending).rejects.toMatchObject({name:'AbortError'});
   await new Promise(r=>setTimeout(r,15));expect(disconnected).toBe(true);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 });
 it('pauses between batches and reports exact chunk progress',async()=>{
  const task=new TaskManager().create('test');let calls=0;
  const server=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{calls++;const input=JSON.parse(b).input;res.end(JSON.stringify({data:input.map((_:unknown,i:number)=>({index:i,embedding:[1,2]}))}));});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
   const original=task.update.bind(task);task.update=(stage,current,total,detail)=>{original(stage,current,total,detail);if(current===32)task.pause();};
   const p=generateEmbeddings(Array(65).fill('正文'),'','model',`http://127.0.0.1:${(server.address() as any).port}`,undefined,undefined,task);
   const deadline=Date.now()+2000;while(task.snapshot.status!=='paused'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
   expect(task.snapshot.status).toBe('paused');expect(calls).toBe(1);task.resume();expect(await p).toHaveLength(65);expect(calls).toBe(3);
  }finally{task.cancel();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 });
});
