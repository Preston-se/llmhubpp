import {beforeAll,afterAll,expect,it} from 'vitest';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createRequire} from 'node:module';
import * as checks from './checks';
import {DEFAULT_SETTINGS} from '../types';
const api=checks as typeof checks & {probeEndpoint?:(context:any,args:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>};
const oldRequire=Object.getOwnPropertyDescriptor(window,'require');
beforeAll(()=>Object.defineProperty(window,'require',{value:createRequire(import.meta.url),configurable:true,writable:true}));
afterAll(()=>{if(oldRequire)Object.defineProperty(window,'require',oldRequire);else Reflect.deleteProperty(window,'require');});
async function endpoint(handler:(req:IncomingMessage,res:ServerResponse)=>void){
 const requests:string[]=[];const server=createServer((req,res)=>{requests.push(req.method+' '+req.url);handler(req,res);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('No test port');
 return {url:'http://127.0.0.1:'+address.port,requests,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
const context=()=>({settings:structuredClone(DEFAULT_SETTINGS)});
const probe=(host:ReturnType<typeof context>,args:Record<string,unknown>,signal?:AbortSignal)=>Promise.resolve(api.probeEndpoint?.(host,args,signal));
it.each([['ollama','/api/tags',{models:[{name:'qwen:4b'}]}],['openai-compatible','/v1/models',{data:[{id:'model:a'}]}]])('probes %s metadata without inference or persistence',async(kind,path,body)=>{
 const target=await endpoint((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));}),host=context(),before=structuredClone(host.settings);
 try{
  const result=await probe(host,{kind,url:target.url});
  expect(result).toMatchObject({success:true,scope:'metadata-only',kind,models:[kind==='ollama'?'qwen:4b':'model:a']});
  expect(target.requests).toEqual(['GET '+path]);expect(host.settings).toEqual(before);
 }finally{await target.close();}
});
it.each([401,403])('distinguishes upstream %s from unreachable without exposing its body',async status=>{
 const target=await endpoint((_req,res)=>{res.statusCode=status;res.end('PRIVATE-UPSTREAM-KEY');});
 try{await expect(probe(context(),{kind:'ollama',url:target.url})).rejects.toMatchObject({code:'upstream-unauthorized',context:expect.objectContaining({status})});}
 finally{await target.close();}
});
it('rejects malformed model metadata instead of claiming the service is usable',async()=>{
 const target=await endpoint((_req,res)=>res.end('not JSON PRIVATE'));
 try{await expect(probe(context(),{kind:'ollama',url:target.url})).rejects.toMatchObject({code:'invalid-upstream-response'});}
 finally{await target.close();}
});
it('supports cancellation and bounded waiting on a real slow endpoint',async()=>{
 const target=await endpoint(()=>{});
 try{
  await expect(probe(context(),{kind:'ollama',url:target.url,timeoutMs:100})).rejects.toMatchObject({code:'probe-timeout'});
  const abort=new AbortController(),pending=probe(context(),{kind:'ollama',url:target.url},abort.signal),cancelled=expect(pending).rejects.toMatchObject({code:'probe-cancelled'});
  abort.abort();await cancelled;
 }finally{await target.close();}
});
it.each(['file:///etc/passwd','http://user:PRIVATE@localhost:1','http://localhost:1/?token=PRIVATE','http://localhost:1/#PRIVATE'])('rejects a non-probe or credential-bearing URL before dispatch',async url=>{
 await expect(probe(context(),{kind:'ollama',url})).rejects.toMatchObject({code:'invalid-arguments'});
});
it('does not send a stored credential to a different origin',async()=>{
 const target=await endpoint((_req,res)=>res.end('{}')),host=context();
 host.settings.apiProviders=[{id:'a',name:'Example',type:'custom',baseUrl:'https://elsewhere.invalid',apiKey:'PRIVATE',enabled:true,verified:false,enabledModels:[],availableModels:[]}];
 try{
  await expect(probe(host,{kind:'openai-compatible',url:target.url,credentialRef:{kind:'api',id:'a'}})).rejects.toMatchObject({code:'credential-origin-mismatch'});
  expect(target.requests).toEqual([]);
 }finally{await target.close();}
});
it('completes MCP HTTP initialization without starting a process or saving configuration',async()=>{
 const methods:string[]=[];const target=await endpoint((req,res)=>{
  let body='';req.on('data',chunk=>body+=String(chunk));req.on('end',()=>{const data=JSON.parse(body);methods.push(data.method);
   if(data.method==='initialize'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:data.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}}));}
   else{res.statusCode=202;res.end();}
  });
 });
 try{
  const host=context(),before=structuredClone(host.settings),result=await probe(host,{kind:'mcp-http',url:target.url+'/mcp'});
  expect(result).toMatchObject({success:true,scope:'handshake-only',protocolVersion:'2025-11-25',capabilities:['tools']});
  expect(methods).toEqual(['initialize','notifications/initialized']);expect(host.settings).toEqual(before);
 }finally{await target.close();}
});
it('respects the existing local-only sending policy before touching a remote endpoint',async()=>{
 const host=context();host.settings.requestControls={budgetEnabled:false,monthlyBudgetCny:300,openingBalanceCny:0,warningRatio:.8,maxOutputTokens:4096,maxToolRounds:20,maxContextChars:0,outbound:'local-only',localOrigins:[],redactionRules:[],rates:[]};
 await expect(probe(host,{kind:'ollama',url:'https://external.invalid'})).rejects.toMatchObject({code:'outbound-policy'});
});
it('limits the response body rather than loading unbounded metadata',async()=>{
 const target=await endpoint((_req,res)=>{res.end(JSON.stringify({models:[{name:'x'.repeat(1100000)}]}));});
 try{await expect(probe(context(),{kind:'ollama',url:target.url})).rejects.toMatchObject({code:'upstream-response-too-large'});}
 finally{await target.close();}
});
it('accepts one complete MCP SSE message without waiting for a persistent stream to close',async()=>{
 const target=await endpoint((req,res)=>{let body='';req.on('data',x=>body+=String(x));req.on('end',()=>{const input=JSON.parse(body);
  if(input.method==='initialize'){res.setHeader('Content-Type','text/event-stream');res.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}})+'\n\n');}
  else{res.statusCode=202;res.end();}
 });});
 try{expect(await probe(context(),{kind:'mcp-http',url:target.url,timeoutMs:250})).toMatchObject({success:true,scope:'handshake-only'});}finally{await target.close();}
});
it('reports an unreachable endpoint without returning raw transport errors',async()=>{
 const target=await endpoint((_req,res)=>res.end());await target.close();
 await expect(probe(context(),{kind:'ollama',url:target.url})).rejects.toMatchObject({code:'upstream-unreachable'});
});
it('initializes a stateful MCP and safely drains bodyless204 session cleanup',async()=>{
 const cleanup:string[]=[];const target=await endpoint((req,res)=>{
  if(req.method==='DELETE'){cleanup.push(String(req.headers['mcp-session-id']));res.statusCode=204;res.end();return;}
  let body='';req.on('data',x=>body+=String(x));req.on('end',()=>{const input=JSON.parse(body);
   if(input.method==='initialize'){res.setHeader('mcp-session-id','synthetic-session');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}}));}
   else{res.statusCode=202;res.end();}
  });
 });
 try{expect(await probe(context(),{kind:'mcp-http',url:target.url,timeoutMs:500})).toMatchObject({success:true,scope:'handshake-only'});expect(cleanup).toEqual(['synthetic-session']);}finally{await target.close();}
});
