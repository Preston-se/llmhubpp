import {it,expect,vi} from 'vitest';
import {configurationFixture} from './configurationFixture.test-utils';
import {executeConfigurationTool} from './mcp/tools';
import * as hostModule from './host';
const api=hostModule as typeof hostModule&{reloadConfiguration?:(configuration:any,args:any,signal?:AbortSignal)=>Promise<any>};
it('reports each live or pending change after one complete transaction',async()=>{
 const f=configurationFixture(),baseRevision=(await f.service.read()).revision;
 const p=await f.service.preview({baseRevision,operations:[{op:'set',moduleId:'settings',fieldId:'maxFunctionCalls',value:23},{op:'set',moduleId:'safeGuard',fieldId:'listenPort',value:11436}]});
 const result:any=await f.service.apply({previewId:p.id,baseRevision,requestId:'mixed'});
 expect(result.persisted).toBe(true);expect(result.changes).toMatchObject([{fieldId:'maxFunctionCalls',saved:true,activation:'applied'},{fieldId:'listenPort',saved:true,activation:'pending-reload'}]);
 expect(f.writes).toEqual(['settings','safeGuard']);expect((await f.service.verify(result.operationId)) as any).toMatchObject({persisted:true,externalChecks:'not-run',runtime:{pending:['safeGuard.listenPort']}});
});
it('keeps a saved configuration distinguishable from a failed activation',async()=>{
 const f=configurationFixture();f.backend.activate=async()=>{throw Error('PRIVATE-DETAIL');};
 const baseRevision=(await f.service.read()).revision,p=await f.service.preview({baseRevision,operations:[{op:'set',moduleId:'settings',fieldId:'maxFunctionCalls',value:23}]});
 const result:any=await f.service.apply({previewId:p.id,baseRevision,requestId:'failed-activation'});
 expect(result).toMatchObject({status:'verification-failed',persisted:true,changes:[{saved:true,activation:'activation-failed'}]});expect(f.raw.settings.maxFunctionCalls).toBe(23);expect(JSON.stringify(result)).not.toContain('PRIVATE-DETAIL');
});
it('requires a preview-bound acknowledgment for protection reduction and preserves idempotent retries',async()=>{
 const f=configurationFixture();f.raw.safeGuard.defaultReadOnlyEnabled=true;
 const baseRevision=(await f.service.read()).revision,operations:any=[{op:'set',moduleId:'safeGuard',fieldId:'defaultReadOnlyEnabled',value:false}];
 const p:any=await f.service.preview({baseRevision,operations}),other:any=await f.service.preview({baseRevision,operations});
 expect(p.risks).toMatchObject([{path:'safeGuard.defaultReadOnlyEnabled',level:'high'}]);expect(p.confirmation.required).toBe(true);
 await expect(executeConfigurationTool(f.service,'configuration_apply',{previewId:p.id,baseRevision,requestId:'risk'})).rejects.toMatchObject({code:'confirmation-required'});
 await expect(executeConfigurationTool(f.service,'configuration_apply',{previewId:other.id,baseRevision,requestId:'wrong',confirmToken:p.confirmation.token})).rejects.toMatchObject({code:'confirmation-invalid'});
 const input={previewId:p.id,baseRevision,requestId:'risk',confirmToken:p.confirmation.token};const result=await executeConfigurationTool(f.service,'configuration_apply',input);
 expect(await executeConfigurationTool(f.service,'configuration_apply',input)).toEqual(result);expect(f.writes).toEqual(['safeGuard']);
});
it('does not require an acknowledgment when strengthening protection or making ordinary edits',async()=>{
 const f=configurationFixture();f.raw.safeGuard.defaultReadOnlyEnabled=false;const baseRevision=(await f.service.read()).revision;
 const p:any=await f.service.preview({baseRevision,operations:[{op:'set',moduleId:'safeGuard',fieldId:'defaultReadOnlyEnabled',value:true}]});
 expect(p.confirmation?.required??false).toBe(false);await f.service.apply({previewId:p.id,baseRevision,requestId:'safer'});
});
it('treats disabling Safe Guard as protection reduction rather than disabling an optional extension',async()=>{
 const f=configurationFixture();f.raw.safeGuard.enabled=true;
 const p:any=await f.service.preview({baseRevision:(await f.service.read()).revision,operations:[{op:'set',moduleId:'safeGuard',fieldId:'enabled',value:false}]});
 expect(p.confirmation?.required).toBe(true);expect(p.risks).toContainEqual(expect.objectContaining({path:'safeGuard.enabled'}));
});
it('reports embedding changes as requiring a separately authorized reindex',async()=>{
 const f=configurationFixture();f.raw.workspace.ragSettings={Study:{chunkSize:500,chunkOverlap:100,topK:5,scoreThreshold:.3,embeddingModel:'old'}};
 const baseRevision=(await f.service.read()).revision,p=await f.service.preview({baseRevision,operations:[{op:'set',moduleId:'workspace',fieldId:'ragSettings.embeddingModel',entityId:'Study',value:'new'}]});
 expect(p.warnings).toContainEqual(expect.objectContaining({code:'REINDEX_REQUIRED'}));expect(f.writes).toEqual([]);
});
it('returns a reviewable risk preview when restoring an older less protected state',async()=>{
 const f=configurationFixture();f.raw.safeGuard.defaultReadOnlyEnabled=false;const baseRevision=(await f.service.read()).revision;
 const p=await f.service.preview({baseRevision,operations:[{op:'set',moduleId:'safeGuard',fieldId:'defaultReadOnlyEnabled',value:true}]}),r=await f.service.apply({previewId:p.id,baseRevision,requestId:'protect'});
 const result:any=await f.service.restore({operationId:r.operationId,baseRevision:r.revision,requestId:'restore-risk'});
 expect(result).toMatchObject({status:'confirmation-required',preview:{confirmation:{required:true},risks:[{path:'safeGuard.defaultReadOnlyEnabled'}]}});expect(f.raw.safeGuard.defaultReadOnlyEnabled).toBe(true);
 const restored=await f.service.apply({previewId:result.preview.id,baseRevision:r.revision,requestId:'restore-reviewed',confirmToken:result.preview.confirmation.token});expect(restored.persisted).toBe(true);expect(f.raw.safeGuard.defaultReadOnlyEnabled).toBe(false);
});
it('detects nested executable changes when a whole collection is updated',async()=>{
 const f=configurationFixture();f.raw.settings.mcpServers=[{id:'m',name:'Demo',transport:'stdio',command:'old',enabled:false}];const baseRevision=(await f.service.read()).revision;
 const p:any=await f.service.preview({baseRevision,operations:[{op:'update',moduleId:'settings',fieldId:'mcpServers',entityId:'m',value:{command:'new'}}]});expect(p.risks).toContainEqual(expect.objectContaining({path:'settings.mcpServers.*.command'}));
});
const reloadFixture=()=>{const f=configurationFixture();f.raw.safeGuard.listenPort=11436;f.raw.safeGuard.listenHost='127.0.0.1';let pending=['safeGuard.listenPort'];return {...f,host:{tasks:{hasUnfinished:()=>false},safeGuard:{getConfigurationRuntimeStatus:()=>({runtime:'listening',activeRequests:0,host:'127.0.0.1',port:11436}),reloadConfigurationProxy:vi.fn(async()=>({applied:true,runtime:'listening',host:'127.0.0.1',port:11436}))}},service:Object.assign(f.service,{getReloadState:()=>({pending:pending.length>0,paths:pending}),markActivated:(paths:string[])=>{pending=pending.filter(path=>!paths.includes(path));}})};};
it('rejects a reload while real proxy requests are active before invoking restart',async()=>{
 const c=reloadFixture();c.host.safeGuard.getConfigurationRuntimeStatus=()=>({runtime:'listening',activeRequests:1,host:'127.0.0.1',port:11435});
 await expect(Promise.resolve(api.reloadConfiguration?.(c,{baseRevision:(await c.service.read()).revision,scopes:['safeGuard']}))).rejects.toMatchObject({code:'busy'});expect(c.host.safeGuard.reloadConfigurationProxy).not.toHaveBeenCalled();
});
it('keeps failed reload pending and leaves the configuration MCP running',async()=>{
 const c=reloadFixture();c.host.safeGuard.reloadConfigurationProxy.mockResolvedValue({applied:false,runtime:'stopped',host:'127.0.0.1',port:11436});
 const result=await api.reloadConfiguration?.(c,{baseRevision:(await c.service.read()).revision,scopes:['safeGuard']});
 expect(result).toMatchObject({status:'pending',pending:['safeGuard.listenPort']});expect(c.service.getReloadState().pending).toBe(true);
});
it('clears only observed applied paths after safe restart and refuses arbitrary scopes',async()=>{
 const c=reloadFixture(),baseRevision=(await c.service.read()).revision;
 await expect(Promise.resolve(api.reloadConfiguration?.(c,{baseRevision,scopes:['shell']}))).rejects.toMatchObject({code:'invalid-arguments'});
 expect(await api.reloadConfiguration?.(c,{baseRevision,scopes:['safeGuard']})).toMatchObject({status:'applied',pending:[]});
});
it('leaves manual-only paths pending with local steps and discloses token renewal',async()=>{
 const c=reloadFixture();c.service.getReloadState=()=>({pending:true,paths:['settings.credentialStorage']});
 expect(await api.reloadConfiguration?.(c,{baseRevision:(await c.service.read()).revision,scopes:['clients']})).toMatchObject({status:'manual-action-required',pending:['settings.credentialStorage'],localSteps:expect.arrayContaining([expect.stringMatching(/重新.*Agent|临时.*连接/)])});
});
