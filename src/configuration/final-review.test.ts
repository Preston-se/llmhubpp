import {it,expect} from 'vitest';
import Ajv from 'ajv';
import {configurationFixture} from './configurationFixture.test-utils';
import {executeConfigurationTool,createConfigurationTools} from './mcp/tools';
import {configurationSuccess} from './mcp/contracts';
const provider=(f:ReturnType<typeof configurationFixture>)=>(f.raw.settings.apiProviders as any[])[0];
const status=(f:ReturnType<typeof configurationFixture>,args:Record<string,unknown>={})=>executeConfigurationTool(f.service,'configuration_status',args) as Promise<any>;
it.each([
 ['destination',{op:'set',moduleId:'safeGuard',fieldId:'upstreamBaseUrl',value:'https://other.invalid'}],
 ['environment',{op:'update',moduleId:'settings',fieldId:'mcpServers',entityId:'m',value:{env:{NODE_OPTIONS:'--require=bad.js'}}}],
])('requires a bound confirmation for a meaningful %s change',async(_name,operation)=>{
 const f=configurationFixture();f.raw.settings.mcpServers=[{id:'m',name:'Runner',transport:'stdio',command:'existing.exe',enabled:true,env:{}}];
 const p:any=await f.service.preview({baseRevision:(await f.service.read()).revision,operations:[operation] as any});
 expect(p.confirmation?.required).toBe(true);expect(p.risks.length).toBeGreaterThan(0);
});
it('preserves managed attestation on a retained entity when its array is replaced',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,availableModels:[],enabledModels:['m'],verification:{verifiedAt:123,fingerprint:'PRIVATE-STALE'}});f.raw.workspace.selectedModel='api:a:m';
 const {verification:_managed,...replacement}=structuredClone(provider(f));
 const baseRevision=(await f.service.read()).revision,p=await f.service.preview({baseRevision,operations:[{op:'set',moduleId:'settings',fieldId:'apiProviders',value:[replacement]}]});
 await f.service.apply({previewId:p.id,baseRevision,requestId:'retained'});
 expect(provider(f).verification?.fingerprint).toBe('PRIVATE-STALE');expect((await status(f)).model).toMatchObject({ready:false,verification:'stale'});
 const next=(await f.service.read()).revision,remove=await f.service.preview({baseRevision:next,operations:[{op:'remove',moduleId:'settings',fieldId:'apiProviders',entityId:'a'},{op:'set',moduleId:'workspace',fieldId:'selectedModel',value:null}]});
 await f.service.apply({previewId:remove.id,baseRevision:next,requestId:'explicit-remove'});expect(f.raw.settings.apiProviders).toEqual([]);
});
it('allows unchanged readonly model lists when retaining an entity in a whole-array update',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,availableModels:['m'],enabledModels:['m']});
 const p=await f.service.preview({baseRevision:(await f.service.read()).revision,operations:[{op:'set',moduleId:'settings',fieldId:'apiProviders',value:[{...provider(f),name:'Renamed'}]}]});
 expect(p.changes).toHaveLength(1);
});
it('resolves a legacy local selection to the same first enabled model as the chat selector',async()=>{
 const f=configurationFixture();f.raw.settings.apiProviders=[];f.raw.settings.localLlmConfigs=[{id:'L',framework:'ollama',baseUrl:'http://127.0.0.1:1',verified:true,enabled:true,model:'old:1',enabledModels:['first:2'],availableModels:['old:1','first:2']}];f.raw.workspace.selectedModel='local-llm:L';
 expect((await status(f)).model).toMatchObject({ready:true,resolved:{model:'first:2'},resolutionSource:'legacy-identifier'});
 const explicit:any=await executeConfigurationTool(f.service,'configuration_resolve_model',{model:'local-llm:L:old:1'});
 expect(explicit).toMatchObject({ready:false,reason:'MODEL_NOT_ENABLED',runtimeFallback:{identifier:'local-llm:L:first:2'}});
});
it('does not suggest stale models that repair itself must reject',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,enabledModels:['m'],verification:{verifiedAt:123,fingerprint:'stale'}});f.raw.workspace.selectedModel='api:a:m';
 const result=await status(f);expect(result.model.suggestions).toEqual([]);expect(result.nextActions).toContain('configuration_check');expect(result.setup.guidance.phase).not.toBe('repair-selection');
});
it('requires credentials for provider routes that cannot run without them',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{type:'opencodego',apiKey:'',verified:true,enabledModels:['m']});f.raw.workspace.selectedModel='api:a:m';
 const result=await status(f);expect(result.model).toMatchObject({ready:false,reason:'CREDENTIAL_MISSING',suggestions:[]});expect(result.nextActions).toContain('local-credential-entry');
});
it('reports a missing map entity rather than a successful empty wildcard result',async()=>{
 const f=configurationFixture();f.raw.workspace.ragSettings={};
 await expect(executeConfigurationTool(f.service,'configuration_read',{fieldPaths:['workspace.ragSettings.missing.topK']})).rejects.toMatchObject({code:'entity-not-found'});
 expect(await executeConfigurationTool(f.service,'configuration_read',{fieldPaths:['workspace.ragSettings.*.topK']})).toMatchObject({empty:true,values:{'workspace.ragSettings.*.topK':[]}});
});
it('keeps a ready model but guides setup of the knowledge base required by the requested use',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,enabledModels:['m']});f.raw.workspace.selectedModel='api:a:m';
 const result=await status(f,{answers:{purpose:'notes'}});expect(result.model.ready).toBe(true);expect(result.setup).toMatchObject({needsSetup:true,reason:'RAG_CONFIGURATION_MISSING'});
 expect(result.setup.guidance.questions).toContainEqual(expect.objectContaining({id:'materials'}));expect(result.setup.guidance.preserveExisting).toBe(true);
});
it.each(['check','probe','reload'])('rejects an unusable %s success that contains only the common envelope',name=>{
 const tool=createConfigurationTools().find(tool=>tool.name==='configuration_'+name)!;
 expect(new Ajv().validate(tool.outputSchema,configurationSuccess({}))).toBe(false);
});
