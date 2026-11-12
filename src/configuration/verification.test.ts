import {it,expect} from 'vitest';
import {configurationFixture} from './configurationFixture.test-utils';
import {getConfigurationStatus} from './diagnostics';
const provider=(f:ReturnType<typeof configurationFixture>)=>(f.raw.settings.apiProviders as any[])[0];
async function save(f:ReturnType<typeof configurationFixture>,value:Record<string,unknown>,trusted=true){
 const baseRevision=(await f.service.read()).revision;
 const p=await (trusted?f.service.previewTrusted.bind(f.service):f.service.preview.bind(f.service))({baseRevision,operations:[{op:'update',moduleId:'settings',fieldId:'apiProviders',entityId:'a',value}]});
 return f.service.apply({previewId:p.id,baseRevision,requestId:crypto.randomUUID()});
}
it('invalidates an attested connection changed by the trusted UI and preserves the model draft',async()=>{
 const f=configurationFixture(),p=provider(f);Object.assign(p,{verified:true,enabledModels:['draft:m'],availableModels:['draft:m'],verification:{verifiedAt:123,fingerprint:'PRIVATE-FINGERPRINT'}});
 await save(f,{baseUrl:'https://changed.test'});
 expect(provider(f)).toMatchObject({verified:false,availableModels:[],enabledModels:['draft:m']});
 expect(provider(f).verification).toBeUndefined();
});
it('invalidates API verification after changing the configured proxy',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,verification:{verifiedAt:123,fingerprint:'PRIVATE-FINGERPRINT'}});
 const baseRevision=(await f.service.read()).revision,p=await f.service.previewTrusted({baseRevision,operations:[{op:'set',moduleId:'settings',fieldId:'proxyUrl',value:'http://127.0.0.1:9999'}]});
 await f.service.apply({previewId:p.id,baseRevision,requestId:'proxy'});expect(provider(f).verified).toBe(false);expect(provider(f).verification).toBeUndefined();
});
it('keeps the endpoint check when only choosing one of its discovered models',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,availableModels:['a','b'],enabledModels:['a'],verification:{verifiedAt:123,fingerprint:'PRIVATE-FINGERPRINT'}});
 await save(f,{enabledModels:['b']});expect(provider(f).verified).toBe(true);expect(provider(f).availableModels).toEqual(['a','b']);
});
it('refuses external verification metadata and never returns its private fingerprint',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,verification:{verifiedAt:123,fingerprint:'PRIVATE-FINGERPRINT'}});
 const json=JSON.stringify(await f.service.read());expect(json).not.toContain('PRIVATE-FINGERPRINT');expect(json).toContain('123');
 await expect(save(f,{verification:{verifiedAt:999,fingerprint:'forged'}},false)).rejects.toMatchObject({code:'readonly'});
});
it('diagnoses a stale persisted attestation without any network request',async()=>{
 const f=configurationFixture();Object.assign(provider(f),{verified:true,enabledModels:['m'],availableModels:['m'],verification:{verifiedAt:123,fingerprint:'PRIVATE-FINGERPRINT'}});f.raw.workspace.selectedModel='api:a:m';
 const status=await getConfigurationStatus({service:f.service});expect(status.model).toMatchObject({ready:false,verification:'stale',reason:'VERIFICATION_STALE'});
 expect(JSON.stringify(status)).not.toContain('PRIVATE-FINGERPRINT');
});
