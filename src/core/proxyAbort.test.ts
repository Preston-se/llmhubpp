import {describe,it,expect} from 'vitest';
import http from 'node:http';
import {createRequire} from 'node:module';
import {createProxyFetch} from './proxyFetch';
import {TaskManager,controlledRequest} from './taskManager';
Object.assign(window,{require:createRequire(import.meta.url)});
describe('proxy handshake controls',()=>{
 it.each(['CONNECT','TLS'])('cancels stalled %s and closes the owned socket',async(phase)=>{
  const sockets=new Set<any>();let disconnected=false;
  const proxy=http.createServer();proxy.on('connection',s=>{sockets.add(s);s.on('end',()=>s.destroy());s.on('close',()=>{sockets.delete(s);disconnected=true;});});
  proxy.on('connect',(_req,s)=>{s.on('data',()=>{});if(phase==='TLS')s.write('HTTP/1.1 200 Connection Established\r\n\r\n');});
  await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
  try{
   const task=new TaskManager().create('test');const fetcher=createProxyFetch(`http://127.0.0.1:${(proxy.address() as any).port}`);
   const pending=controlledRequest(task,signal=>fetcher('https://127.0.0.1:443',{signal}),40).then(()=> 'unexpected',e=>e.name);
   const result=await Promise.race([pending,new Promise(r=>setTimeout(()=>r('hung'),200))]);
   expect(result).toBe('TimeoutError');await new Promise(r=>setTimeout(r,15));expect(disconnected).toBe(true);
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(r=>proxy.close(()=>r()));}
 });
});
