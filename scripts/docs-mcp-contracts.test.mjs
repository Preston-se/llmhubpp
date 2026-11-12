import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,symlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
let fixture,check;
before(async()=>{
 const base=path.join(root,'.superpowers/execution/mcp-wiki-guidance/docs-negative-fixtures');await mkdir(base,{recursive:true});fixture=await mkdtemp(path.join(base,'case-'));
 for(const name of ['src','resources/help','scripts'])await cp(path.join(root,name),path.join(fixture,name),{recursive:true});
 for(const name of ['tsconfig.json','package.json'])await cp(path.join(root,name),path.join(fixture,name));
 await symlink(path.join(root,'node_modules'),path.join(fixture,'node_modules'),'junction');
 check=(await import('./check-docs-mcp.mjs').catch(()=>({}))).checkDocumentationAndMcp;
});
const inspect=async()=>check?await check({root:fixture}):[{code:'checker-unavailable'}];
async function mutate(name,transform,run){const file=path.join(fixture,name),before=await readFile(file,'utf8');await writeFile(file,transform(before));try{return await run();}finally{await writeFile(file,before);}}
test('the complete source, user guides and MCP contract pass together',async()=>assert.deepEqual(await inspect(),[]));
test('new, removed and renamed real nested type fields fail bidirectional documentation coverage',async()=>{
 const generated=await readFile(path.join(fixture,'src/configuration/generatedSchema.ts'),'utf8');
 for(const change of [s=>s.replace('export interface LocalLlmConfig {','export interface LocalLlmConfig {\n  futureProbeDepth?: number;'),s=>s.replace('streamIdleTimeoutSeconds?: number;',''),s=>s.replace('streamIdleTimeoutSeconds?: number;','renamedIdleSeconds?: number;')]){
  await mutate('src/types/index.ts',change,async()=>{
   const run=spawnSync(process.execPath,[path.join(root,'scripts/generate-configuration-schema.mjs')],{cwd:fixture,encoding:'utf8'});assert.equal(run.status,0,run.stderr);
   const issues=await inspect();assert.ok(issues.some(issue=>['missing-field','orphan-field'].includes(issue.code)),JSON.stringify(issues));
  });await writeFile(path.join(fixture,'src/configuration/generatedSchema.ts'),generated);
 }
});
test('a real new settings section without Wiki/MCP mapping fails',async()=>mutate('src/ui/settings/settingsRegistry.ts',s=>s.replace('["api",','["futurePanel","Future panel","新设置",[]],\n      ["api",'),async()=>assert.ok((await inspect()).some(issue=>issue.code==='missing-feature'&&issue.path==='settings:futurePanel'))));
test('broken article anchors, image targets and alternative text fail',async()=>{
 await mutate('resources/help/index.md',s=>s+'\n[坏锚点](help:first-setup#never-defined)\n',async()=>assert.ok((await inspect()).some(issue=>issue.code==='bad-anchor')));
 await mutate('resources/help/index.md',s=>s+'\n![不存在的流程](images/never-defined.svg)\n',async()=>assert.ok((await inspect()).some(issue=>issue.code==='missing-image')));
 await mutate('resources/help/index.md',s=>s+'\n![](images/index.svg)\n',async()=>assert.ok((await inspect()).some(issue=>issue.code==='missing-alt')));
});
test('a semantic recommendation of the wrong type fails before packaging',async()=>mutate('src/configuration/knowledge.ts',s=>s.replace('value:Reflect.get(DEFAULT_RAG_SETTING,leaf)','value:"invalid-number"'),async()=>assert.ok((await inspect()).some(issue=>issue.code==='invalid-recommendation'))));
test('a schema that disagrees with a real tool result fails the consumer check',async()=>mutate('src/configuration/mcp/contracts.ts',s=>s.replace('read:{revision:text,','read:{revision:{type:"number"},'),async()=>assert.ok((await inspect()).some(issue=>issue.code==='consumer-output'))));
test('dropping an extension-backed probe payload fails the actual tool consumer gate',async()=>mutate('src/configuration/mcp/tools.ts',s=>s.replace('if(extra.probe)return extra.probe(args,signal)','if(extra.probe)return {success:true}'),async()=>assert.ok((await inspect()).some(issue=>issue.code==='consumer-output'&&issue.path==='configuration_probe'))));
test('removing a feature MCP mapping or declaring an orphan is rejected',async()=>{
 await mutate('resources/help/feature-map.json',s=>{const map=JSON.parse(s);map[0].mcp={};return JSON.stringify(map);},async()=>assert.ok((await inspect()).some(issue=>issue.code==='missing-mcp-mapping')));
 await mutate('resources/help/feature-map.json',s=>{const map=JSON.parse(s);map.push({id:'settings:removedPanel',userTopic:'first-setup',mcp:{fields:['settings.apiProviders']}});return JSON.stringify(map);},async()=>assert.ok((await inspect()).some(issue=>issue.code==='orphan-feature')));
});
