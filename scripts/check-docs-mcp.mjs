import {build} from 'esbuild';
import Ajv from 'ajv';
import ts from 'typescript';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {helpAnchors} from './help-markdown.mjs';
const sourceRoot=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
async function contracts(root){
 const contents="export{createRegistry,getDocumentationIndex,validateDocumentationCoverage}from'./src/configuration/registry';export{collectFieldPaths}from'./src/configuration/schemaPaths';export{createConfigurationTools,executeConfigurationTool}from'./src/configuration/mcp/tools';export{configurationSuccess}from'./src/configuration/mcp/contracts';export{configurationError}from'./src/configuration/errors';export{configurationFixture}from'./src/configuration/configurationFixture.test-utils';export{HELP_TOPICS}from'./src/ui/helpRoutes';";
 const compiled=await build({stdin:{contents,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian'],nodePaths:[path.join(sourceRoot,'node_modules')],logLevel:'silent'});
 const runtime={exports:{}},hostlessRequire=name=>name==='obsidian'?{Platform:{isMobile:false},TFile:class{},requestUrl:()=>{throw Error('Documentation check cannot send requests');}}:require(name);
 new Function('require','module','exports',compiled.outputFiles[0].text)(hostlessRequire,runtime,runtime.exports);
 return runtime.exports;
}
function sectionIds(source){
 const tree=ts.createSourceFile('settingsRegistry.ts',source,ts.ScriptTarget.Latest,true),ids=new Set();
 const visit=node=>{
  if(ts.isArrayLiteralExpression(node)&&node.elements.length===4){
   const [id,en,zh,aliases]=node.elements;
   if(ts.isStringLiteralLike(id)&&ts.isStringLiteralLike(en)&&ts.isStringLiteralLike(zh)&&ts.isArrayLiteralExpression(aliases)&&aliases.elements.every(ts.isStringLiteralLike))ids.add(id.text);
  }
  ts.forEachChild(node,visit);
 };visit(tree);return ids;
}
export async function checkDocumentationAndMcp({root=sourceRoot,registry,knowledge,features}={}){
 const issues=[],add=(code,item,detail)=>issues.push({code,path:item,...(detail?{detail}: {})});
 const api=await contracts(root),fields=registry??api.createRegistry(),paths=api.collectFieldPaths(fields),docs=knowledge??api.getDocumentationIndex(fields);
 for(const issue of api.validateDocumentationCoverage(paths,docs))issues.push(issue);
 const knownPaths=new Set(paths.map(field=>field.path)),tools=api.createConfigurationTools(),knownTools=new Set(tools.map(tool=>tool.name)),consumer=new Ajv({allErrors:true});
 const pages=new Map(),helpRoot=path.join(root,'resources/help');
 for(const name of (await readdir(helpRoot)).filter(name=>name.endsWith('.md')))pages.set(name.slice(0,-3),await readFile(path.join(helpRoot,name),'utf8'));
 const anchors=new Map([...pages].map(([name,text])=>[name,new Set(helpAnchors(text))]));
 const sections=sectionIds(await readFile(path.join(root,'src/ui/settings/settingsRegistry.ts'),'utf8'));
 const {HELP_ASSETS}=await import(pathToFileURL(path.join(root,'scripts/help-assets.mjs')).href+'?check='+Date.now()+Math.random());
 const assets=new Set(HELP_ASSETS);
 for(const topic of Object.keys(api.HELP_TOPICS))if(!pages.has(topic)||!assets.has('resources/help/'+topic+'.md'))add('missing-topic',topic);
 for(const [name,text]of pages){
  if(!api.HELP_TOPICS[name])add('orphan-topic',name);
  if(!['index','configuration-fields','agent-onboarding'].includes(name)&&(text.match(/^## /gm)??[]).length<3)add('incomplete-user-guide',name);
  for(const match of text.matchAll(/\]\(help:([a-z0-9-]+)(?:#([a-z0-9-]+))?\)/g)){
   if(!pages.has(match[1]))add('bad-topic',name+':'+match[1]);
   else if(match[2]&&!anchors.get(match[1]).has(match[2]))add('bad-anchor',name+':'+match[1]+'#'+match[2]);
  }
  for(const match of text.matchAll(/\]\(settings:([A-Za-z0-9-]+)\)/g))if(!sections.has(match[1]))add('bad-settings-link',name+':'+match[1]);
  for(const match of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)){
   if(match[1].trim().length<4)add('missing-alt',name);
   if(!/^images\/[a-z0-9-]+\.svg$/.test(match[2])){add('nonlocal-image',name+':'+match[2]);continue;}
   let svg;try{svg=await readFile(path.join(helpRoot,match[2]),'utf8');}catch{add('missing-image',name+':'+match[2]);continue;}
   if(!assets.has('resources/help/'+match[2]))add('unpackaged-image',name+':'+match[2]);
   if(!/<svg\b/.test(svg)||!/\bviewBox=/.test(svg)||!/<title\b/.test(svg)||!/<desc\b/.test(svg))add('inaccessible-image',name+':'+match[2]);
  }
 }
 for(const field of docs){
  if(!pages.has(field.userTopic))add('bad-field-topic',field.path);
  if(!anchors.get('configuration-fields')?.has(field.anchor))add('missing-field-anchor',field.path);
 }
 const entries=features??JSON.parse(await readFile(path.join(helpRoot,'feature-map.json'),'utf8')),featureIds=new Set();
 for(const feature of entries){
  if(featureIds.has(feature.id))add('duplicate-feature',feature.id);featureIds.add(feature.id);
  if(!pages.has(feature.userTopic))add('bad-feature-topic',feature.id);
  if(feature.id.startsWith('settings:')&&!sections.has(feature.id.slice(9)))add('orphan-feature',feature.id);
  const mcp=feature.mcp??{},fields=mcp.fields??[],mappedTools=mcp.tools??[];
  if(!fields.length&&!mappedTools.length&&!(typeof mcp.boundary==='string'&&mcp.boundary.length>15))add('missing-mcp-mapping',feature.id);
  for(const field of fields)if(!knownPaths.has(field))add('unknown-feature-field',feature.id+':'+field);
  for(const tool of mappedTools)if(!knownTools.has(tool))add('unknown-feature-tool',feature.id+':'+tool);
 }
 for(const id of sections)if(!featureIds.has('settings:'+id))add('missing-feature','settings:'+id);
 const guide=pages.get('mcp-agent-guide')??'';
 for(const tool of tools){
  if(!tool.title||tool.description.length<80||!['readOnlyHint','destructiveHint','openWorldHint','idempotentHint'].every(key=>typeof tool.annotations[key]==='boolean'))add('tool-metadata',tool.name);
  if(!guide.includes(tool.name))add('undocumented-tool',tool.name);
  try{consumer.compile(tool.inputSchema);consumer.compile(tool.outputSchema);}catch{add('invalid-tool-schema',tool.name);}
  if(consumer.validate(tool.outputSchema,api.configurationSuccess({})))add('incomplete-output-contract',tool.name);
 }
 const f=api.configurationFixture();
 async function output(name,args,extensions={}){
  const tool=tools.find(tool=>tool.name==='configuration_'+name);if(!tool)return;
  try{
   const value=api.configurationSuccess(await api.executeConfigurationTool(f.service,tool.name,args,extensions));
   if(!consumer.validate(tool.outputSchema,value))add('consumer-output',tool.name);
   if(JSON.stringify(value).includes('PRIVATE-KEY'))add('secret-output',tool.name);
   return value;
  }catch(error){add('consumer-execution','configuration_'+name,String(error.code??'failed'));}
 }
 for(const tool of tools)try{await api.executeConfigurationTool(f.service,tool.name,{__invalid:true});add('consumer-error-boundary',tool.name);}catch(error){if(!consumer.validate(tool.outputSchema,api.configurationError(error)))add('consumer-error-schema',tool.name);}
 for(const [name,args]of [['status',{}],['resolve_model',{}],['repair',{}],['read',{fieldPaths:['settings.maxFunctionCalls']}],['describe',{detail:'summary',fieldPaths:['settings.maxFunctionCalls']}]])await output(name,args);
 const snapshot=await f.service.read(),preview=await output('preview',{baseRevision:snapshot.revision,operations:[{op:'set',moduleId:'settings',fieldId:'maxFunctionCalls',value:23}]});
 if(preview){const applied=await output('apply',{previewId:preview.id,baseRevision:snapshot.revision,requestId:'docs-consumer'});if(applied){await output('verify',{operationId:applied.operationId});await output('history',{});await output('restore',{operationId:applied.operationId,baseRevision:applied.revision,requestId:'docs-restore'});}}
 // Controlled callbacks exercise the production extension dispatch and envelope;
 // real HTTP probe/check and protocol behavior are also run by check:docs-mcp.
 const extensions={check:async()=>({exists:true,scope:'vault'}),probe:async()=>({success:true,kind:'ollama',scope:'metadata-only',models:['fixture'],elapsedMs:1}),reload:async()=>({revision:'r',status:'applied',applied:[],pending:[],localSteps:[]}),export:async()=>({handle:'fixture',path:'/configuration-bundles/fixture'}),importPreview:async()=>({id:'fixture',baseRevision:'r',changes:[],issues:[],reloadRequired:false})};
 for(const[name,args]of [['check',{kind:'path',targetId:'fixture'}],['probe',{kind:'ollama',url:'http://127.0.0.1:1'}],['reload',{baseRevision:'r',scopes:['clients']}],['export',{}],['import_preview',{uploadHandle:'fixture'}]])await output(name,args,extensions);
 return issues;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const issues=await checkDocumentationAndMcp();
 if(issues.length){console.error(JSON.stringify(issues,null,2));process.exitCode=1;}
 else console.log('Wiki/MCP check passed: public nested fields, semantic examples, user pages/anchors/assets, settings/features and actual tool consumer contracts.');
}
