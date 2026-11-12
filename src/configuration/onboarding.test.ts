import {it,expect} from 'vitest';
import {configurationFixture} from './configurationFixture.test-utils';
import {executeConfigurationTool} from './mcp/tools';
it('provides five explained core questions without writing or installing anything',async()=>{
 const f=configurationFixture();f.raw.settings.apiProviders=[];
 const result:any=await executeConfigurationTool(f.service,'configuration_status',{});
 expect(result.setup.guidance.phase).toBe('ask-core');expect(result.setup.guidance.questions.map((q:any)=>q.id)).toEqual(['purpose','modelLocation','privacy','budget','materials']);
 expect(result.setup.guidance.questions.every((q:any)=>q.explanation.length>15&&q.options.length>1)).toBe(true);expect(f.writes).toEqual([]);
 expect(result.setup.guidance.credentialInstruction).toMatch(/本地.*密钥/);
});
it('skips known answers and explains conditional recommendations from source defaults',async()=>{
 const f=configurationFixture();f.raw.settings.apiProviders=[];
 const result:any=await executeConfigurationTool(f.service,'configuration_status',{answers:{purpose:'notes',modelLocation:'local',privacy:'local-only',budget:{paid:false},materials:'existing-index'}});
 expect(result.setup.guidance.questions).toEqual([]);expect(result.setup.guidance.phase).toBe('propose');
 expect(result.setup.guidance.recommendations).toContainEqual(expect.objectContaining({path:'workspace.ragSettings.*.topK',value:5,when:expect.any(String),why:expect.any(String),impacts:expect.arrayContaining([expect.stringMatching(/更多/),expect.stringMatching(/更少/)])}));
 expect(result.setup.guidance.recommendations).toContainEqual(expect.objectContaining({path:'settings.requestControls.outbound',value:'local-only'}));expect(f.writes).toEqual([]);
});
it('repairs a dead selection while preserving the already configured provider',async()=>{
 const f=configurationFixture();Object.assign((f.raw.settings.apiProviders as any[])[0],{verified:true,enabledModels:['ready:m']});f.raw.workspace.selectedModel='api:missing:m';
 const result:any=await executeConfigurationTool(f.service,'configuration_status',{});
 expect(result.setup.guidance).toMatchObject({phase:'repair-selection',questions:[],preserveExisting:true});expect(result.nextActions).toContain('configuration_repair');
});
it('keeps partial connection configuration and requests only missing preferences',async()=>{
 const f=configurationFixture();const before=structuredClone(f.raw);
 const result:any=await executeConfigurationTool(f.service,'configuration_status',{answers:{purpose:'chat',privacy:'confirm'}});
 expect(result.setup.guidance.questions.map((q:any)=>q.id)).not.toContain('modelLocation');expect(result.setup.guidance.questions.map((q:any)=>q.id)).not.toContain('privacy');expect(result.setup.guidance.preserveExisting).toBe(true);expect(f.raw).toEqual(before);
});
it('refuses secrets and unknown guidance fields instead of echoing them into prompts',async()=>{
 const f=configurationFixture();await expect(executeConfigurationTool(f.service,'configuration_status',{answers:{apiKey:'PRIVATE'}})).rejects.toMatchObject({code:'invalid-arguments'});
});
it('keeps existing user values rather than proposing source defaults over them',async()=>{
 const f=configurationFixture();f.raw.settings.requestControls={maxOutputTokens:2048,maxToolRounds:8};
 const result:any=await executeConfigurationTool(f.service,'configuration_status',{answers:{purpose:'chat'}});
 expect(result.setup.guidance.recommendations).toContainEqual(expect.objectContaining({path:'settings.requestControls.maxOutputTokens',value:2048,action:'keep'}));
});
it('asks for missing budget amounts after learning only that the user will pay',async()=>{
 const f=configurationFixture();f.raw.settings.apiProviders=[];
 const result:any=await executeConfigurationTool(f.service,'configuration_status',{answers:{purpose:'chat',modelLocation:'cloud',privacy:'confirm',budget:{paid:true}}});
 expect(result.setup.guidance.questions).toContainEqual(expect.objectContaining({id:'budget',title:expect.stringMatching(/金额|支出/)}));expect(result.setup.guidance.phase).toBe('ask-core');
});
