import { expect,it,vi } from 'vitest';
import { executeConfigurationTool } from './mcp/tools';
import { configurationFixture } from './configurationFixture.test-utils';
function readyApi(f:ReturnType<typeof configurationFixture>){
 const entry=(f.raw.settings.apiProviders as any[])[0];entry.verified=true;entry.enabledModels=['model:with:tag'];entry.availableModels=['model:with:tag'];return entry;
}
it('reports empty configuration without network calls or writes',async()=>{
 const f=configurationFixture();f.raw.settings.apiProviders=[];f.raw.workspace.selectedModel=null;
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('status must not send'));
 try{
  const status:any=await executeConfigurationTool(f.service,'configuration_status',{});
  expect(status.setup.needsSetup).toBe(true);expect(status.model.ready).toBe(false);
  expect(status.guard.upstreamReachable).toBe('unknown');expect(f.writes).toEqual([]);expect(network).not.toHaveBeenCalled();
 }finally{network.mockRestore();}
});
it('reports a missing provider instead of silently routing to another configured model',async()=>{
 const f=configurationFixture();readyApi(f);f.raw.workspace.selectedModel='api:removed:m';
 await expect(executeConfigurationTool(f.service,'configuration_resolve_model',{})).resolves.toMatchObject({resolved:null,ready:false,reason:'PROVIDER_MISSING',suggestions:['api:a:model:with:tag']});
});
it('preserves colon-separated local model tags and explicit entity identity',async()=>{
 const f=configurationFixture();f.raw.settings.localLlmConfigs=[{id:'l',name:'Local',framework:'ollama',baseUrl:'http://127.0.0.1:11434',verified:true,enabled:true,model:'qwen:4b',enabledModels:['qwen:4b'],availableModels:['qwen:4b']}];
 f.raw.workspace.selectedModel='local-llm:l:qwen:4b';
 await expect(executeConfigurationTool(f.service,'configuration_resolve_model',{})).resolves.toMatchObject({resolved:{kind:'local',configId:'l',model:'qwen:4b'},ready:true});
});
it.each([['disabled','CONFIG_DISABLED'],['unverified','UNVERIFIED'],['model-missing','MODEL_NOT_ENABLED']])('distinguishes %s selections',async(kind,reason)=>{
 const f=configurationFixture(),entry=readyApi(f);f.raw.workspace.selectedModel='api:a:model:with:tag';
 if(kind==='disabled')entry.enabled=false;if(kind==='unverified')entry.verified=false;if(kind==='model-missing')entry.enabledModels=['other'];
 await expect(executeConfigurationTool(f.service,'configuration_resolve_model',{})).resolves.toMatchObject({ready:false,reason});
});
it('reports a legacy model suffix fallback explicitly',async()=>{
 const f=configurationFixture();readyApi(f);f.raw.workspace.selectedModel='api:a';
 await expect(executeConfigurationTool(f.service,'configuration_resolve_model',{})).resolves.toMatchObject({ready:true,resolutionSource:'legacy-identifier',resolved:{model:'model:with:tag'}});
});
it('resolves an already verified CLI without requiring a remote provider',async()=>{
 const f=configurationFixture();f.raw.settings.apiProviders=[];f.raw.settings.cliConfig={codexCliVerified:true};f.raw.workspace.selectedModel='codex-cli';
 await expect(executeConfigurationTool(f.service,'configuration_status',{})).resolves.toMatchObject({model:{ready:true,resolved:{kind:'cli',configId:'codex-cli'}},setup:{needsSetup:false}});
});
it('reports the built-in Gemini provider through its configured API identity',async()=>{
 const f=configurationFixture(),entry=readyApi(f);entry.type='gemini';entry.enabledModels=['gemini-3.8-flash'];f.raw.workspace.selectedModel='api:a:gemini-3.8-flash';
 await expect(executeConfigurationTool(f.service,'configuration_resolve_model',{})).resolves.toMatchObject({ready:true,resolved:{kind:'api',configId:'a',model:'gemini-3.8-flash'}});
});
it('keeps an uninspected external index read-only and does not invent readiness',async()=>{
 const f=configurationFixture();readyApi(f);f.raw.workspace.selectedModel='api:a:model:with:tag';f.raw.workspace.selectedRagSetting='Old';
 f.raw.workspace.ragSettings={Old:{externalIndexPath:'kept/index',embeddingModel:'qwen-embed',sourceRagSettings:[]}};
 await expect(executeConfigurationTool(f.service,'configuration_status',{})).resolves.toMatchObject({rag:{selected:'Old',kind:'external',readOnly:true,indexReady:'unknown',needsReindex:'unknown'}});
 expect(f.writes).toEqual([]);
});
it('previews a requested repair and applies it only through the original transaction',async()=>{
 const f=configurationFixture();readyApi(f);f.raw.workspace.selectedModel='api:removed:m';
 const read=await f.service.read();
 const suggestions:any=await executeConfigurationTool(f.service,'configuration_repair',{});
 expect(suggestions.preview).toBe(false);expect(f.raw.workspace.selectedModel).toBe('api:removed:m');
 const preview:any=await executeConfigurationTool(f.service,'configuration_repair',{targetModel:'api:a:model:with:tag',baseRevision:read.revision});
 expect(preview.preview).toBe(true);expect(f.writes).toEqual([]);expect(f.raw.workspace.selectedModel).toBe('api:removed:m');
 await f.service.apply({previewId:preview.id,baseRevision:read.revision,requestId:'repair'});
 expect(f.raw.workspace.selectedModel).toBe('api:a:model:with:tag');
});
it('warns about an untouched stale reference while allowing an unrelated repair',async()=>{
 const f=configurationFixture();f.raw.workspace.selectedModel='api:missing:m';
 const read:any=await executeConfigurationTool(f.service,'configuration_read',{});
 expect(read.warnings).toContainEqual(expect.objectContaining({code:'DANGLING_MODEL_REFERENCE',path:'workspace.selectedModel'}));
 const preview=await f.service.preview({baseRevision:read.revision,operations:[{op:'set',moduleId:'settings',fieldId:'maxFunctionCalls',value:22}]});
 const applied=await f.service.apply({previewId:preview.id,baseRevision:read.revision,requestId:'unrelated'});
 expect((applied as any).warnings??[]).toContainEqual(expect.objectContaining({code:'DANGLING_MODEL_REFERENCE',path:'workspace.selectedModel'}));
 expect(f.raw.settings.maxFunctionCalls).toBe(22);
});
it('rejects a newly selected missing model without disturbing the current configuration',async()=>{
 const f=configurationFixture();readyApi(f);f.raw.workspace.selectedModel='api:a:model:with:tag';const read=await f.service.read();
 await expect(f.service.preview({baseRevision:read.revision,operations:[{op:'set',moduleId:'workspace',fieldId:'selectedModel',value:'api:nope:m'}]})).rejects.toMatchObject({code:'dependency-unresolved'});
 expect(f.writes).toEqual([]);
});
