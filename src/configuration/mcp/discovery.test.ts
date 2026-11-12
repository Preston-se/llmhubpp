import {it,expect} from 'vitest';
import Ajv from 'ajv';
import {ConfigurationMcpServer} from './server';
import {configurationFixture} from '../configurationFixture.test-utils';
import type {ConfigurationToolExtensions} from './tools';
async function client(extra:ConfigurationToolExtensions={}){
 const f=configurationFixture(),server=new ConfigurationMcpServer(f.service,extra),connection=await server.start();let id=0;
 const rpc=async(method:string,params:unknown={})=>(await (await fetch(connection.endpoint,{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})})).json());
 return {f,server,rpc};
}
it('announces compact instructions, resources and three task prompts while retaining the old guide',async()=>{
 const c=await client();try{
  const hello=(await c.rpc('initialize',{protocolVersion:'2025-11-25'})).result;
  expect(hello.capabilities).toMatchObject({resources:{},prompts:{},tools:{}});expect(hello.instructions).toMatch(/configuration_status/);expect(hello.instructions.length).toBeLessThan(1400);
  const templates=(await c.rpc('resources/templates/list')).result;expect(templates.resourceTemplates).toContainEqual(expect.objectContaining({uriTemplate:'llmhubpp://docs/field/{path}'}));
  const prompts=(await c.rpc('prompts/list')).result;expect(prompts.prompts.map((p:any)=>p.name)).toEqual(['first-setup','repair-model','merge-restore']);
  const prompt=(await c.rpc('prompts/get',{name:'first-setup',arguments:{answers:JSON.stringify({privacy:'local-only'})}})).result;
  expect(prompt.messages[0].content.text).toMatch(/本地.*密钥/);expect(prompt.messages[0].content.text).toMatch(/用途/);
  const guide=(await c.rpc('resources/read',{uri:'llmhubpp://configuration/guide'})).result;expect(guide.contents[0].text).toContain('configuration_preview');
  expect(guide.contents[0].text.length).toBeLessThan(7000);expect(c.f.writes).toEqual([]);
 }finally{await c.server.dispose();}
});
it('marks a failed managed check as an actionable execution failure and retains its success flag',async()=>{
 const c=await client({check:async()=>({success:false,code:'connection-failed'})});try{
  const result=(await c.rpc('tools/call',{name:'configuration_check',arguments:{kind:'api',targetId:'a'}})).result;
  expect(result).toMatchObject({isError:true,structuredContent:{ok:false,success:false,code:'CONNECTION_FAILED',retryable:true}});
 }finally{await c.server.dispose();}
});
it('validates external-capability success schemas through controlled host callbacks',async()=>{
 // Callbacks are transport fixtures here; their real HTTP/runtime behavior has separate probe/host/native coverage.
 const c=await client({check:async()=>({success:true,models:['m']}),probe:async()=>({success:true,kind:'ollama',scope:'metadata-only',models:['m'],elapsedMs:1}),reload:async()=>({revision:'r',status:'applied',applied:[],pending:[],localSteps:[]}),export:async()=>({handle:'fixture',path:'/configuration-bundles/fixture'}),importPreview:async()=>({id:'fixture',baseRevision:'r',changes:[],issues:[],reloadRequired:false})});
 try{
  const list=(await c.rpc('tools/list')).result.tools,consumer=new Ajv({allErrors:true});
  for(const [name,args] of [['check',{kind:'path',targetId:'x'}],['probe',{kind:'ollama',url:'http://127.0.0.1:1'}],['reload',{baseRevision:'r',scopes:['clients']}],['export',{}],['import_preview',{uploadHandle:'fixture'}]] as const){
   const result=(await c.rpc('tools/call',{name:'configuration_'+name,arguments:args})).result;expect(result.isError).not.toBe(true);expect(consumer.validate(list.find((t:any)=>t.name==='configuration_'+name).outputSchema,result.structuredContent),JSON.stringify(consumer.errors)).toBe(true);
  }
 }finally{await c.server.dispose();}
});
it('loads field explanations lazily and refuses traversal, encoded secrets and unknown URIs',async()=>{
 const c=await client();try{
  const resource=(await c.rpc('resources/read',{uri:'llmhubpp://docs/field/'+encodeURIComponent('workspace.ragSettings.*.topK')})).result;
  expect(resource.contents[0].text).toMatch(/推荐起点/);expect(resource.contents[0].text).toMatch(/更多/);
  for(const uri of ['file:///D:/secret','llmhubpp://docs/field/../../data.json','llmhubpp://docs/field/%252e%252e','llmhubpp://docs/field/settings.apiProviders.*.apiKey?PRIVATE'])expect((await c.rpc('resources/read',{uri})).error?.code).toBe(-32602);
  const read=(await c.rpc('tools/call',{name:'configuration_read',arguments:{fieldPaths:['settings.maxFunctionCalls']}})).result;
  expect(JSON.stringify(read.structuredContent).length).toBeLessThan(1024);expect(JSON.stringify(resource)).not.toContain('PRIVATE-KEY');expect(c.f.writes).toEqual([]);
 }finally{await c.server.dispose();}
});
it('offers consumer-valid success and recoverable failure contracts for all fifteen tools',async()=>{
 const c=await client();try{
  const list=(await c.rpc('tools/list')).result.tools;expect(list).toHaveLength(15);const consumer=new Ajv({allErrors:true});
  for(const tool of list){
   expect(tool.title).toBeTruthy();for(const name of ['readOnlyHint','destructiveHint','openWorldHint','idempotentHint'])expect(typeof tool.annotations[name]).toBe('boolean');
   const error=(await c.rpc('tools/call',{name:tool.name,arguments:{__invalid:true}})).result;
   expect(error.isError).toBe(true);expect(consumer.validate(tool.outputSchema,error.structuredContent),JSON.stringify(consumer.errors)).toBe(true);
  }
  const call=async(name:string,args:unknown)=>{
   const result=(await c.rpc('tools/call',{name:'configuration_'+name,arguments:args})).result;
   expect(result.isError,JSON.stringify(result)).not.toBe(true);
   expect(consumer.validate(list.find((t:any)=>t.name==='configuration_'+name).outputSchema,result.structuredContent),JSON.stringify(consumer.errors)).toBe(true);return result.structuredContent;
  };
  for(const [name,args]of [['status',{}],['resolve_model',{}],['repair',{}],['describe',{detail:'summary',fieldPaths:['settings.maxFunctionCalls']}],['read',{fieldPaths:['settings.maxFunctionCalls']}]] as const)await call(name,args);
  const baseRevision=(await c.f.service.read()).revision,p=await call('preview',{baseRevision,operations:[{op:'set',moduleId:'settings',fieldId:'maxFunctionCalls',value:23}]}),a=await call('apply',{baseRevision,previewId:p.id,requestId:'consumer'});
  await call('verify',{operationId:a.operationId});await call('history',{});await call('restore',{operationId:a.operationId,baseRevision:a.revision,requestId:'restore'});
  expect(JSON.stringify(await c.rpc('tools/call',{name:'configuration_status',arguments:{}}))).not.toContain('PRIVATE-KEY');
 }finally{await c.server.dispose();}
});
