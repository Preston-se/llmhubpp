import { expect, it } from 'vitest';
import * as registry from './registry';
import { collectFieldPaths } from './query';
import { configurationFixture } from './configurationFixture.test-utils';
import { executeConfigurationTool } from './mcp/tools';
import { DEFAULT_RAG_SETTING } from '../types';
import { DEFAULT_REQUEST_CONTROLS } from '../core/requestUsage';
import { ROOT_DOCUMENTATION } from './documentationCatalog';

const knowledge=registry as typeof registry & {
    getDocumentationIndex?: (fields:ReturnType<typeof registry.createRegistry>)=>any[];
    validateDocumentationCoverage?: (fields:any[],docs:any[])=>{code:string;path:string}[];
};
it('explains retrieval and budgeting choices at the compact discovery boundary',async()=>{
    const f=configurationFixture();
    const result:any=await executeConfigurationTool(f.service,'configuration_describe',{fieldPaths:['workspace.ragSettings.*.topK','settings.requestControls.monthlyBudgetCny'],detail:'summary'});
    const retrieval=result.fields.find((field:any)=>field.path==='workspace.ragSettings.*.topK');
    expect(retrieval).toMatchObject({title:expect.any(String),recommendation:expect.any(Object),impacts:expect.any(Array)});
    expect(retrieval.summary).not.toBe('topK');
    expect(retrieval.recommendation.value).toBe(DEFAULT_RAG_SETTING.topK);
    expect(retrieval.recommendation.when.length).toBeGreaterThan(8);
    expect(retrieval.impacts.length).toBeGreaterThan(1);
    const budget=result.fields.find((field:any)=>field.path==='settings.requestControls.monthlyBudgetCny');
    expect(budget.recommendation.value).toBe(DEFAULT_REQUEST_CONTROLS.monthlyBudgetCny);
    expect(budget.unit).toBe('CNY/月');
    expect(JSON.stringify(result).length).toBeLessThan(5000);
});
it('has actual explanations and resolvable help for every published nested configuration path',()=>{
    const fields=registry.createRegistry(),docs=knowledge.getDocumentationIndex?.(fields);
    expect(docs?.find(field=>field.path==='settings.apiProviders.*.baseUrl')).toMatchObject({risk:'medium',userTopic:'first-setup'});
    expect(docs?.find(field=>field.path==='safeGuard.defaultReadOnlyEnabled')).toMatchObject({risk:'high'});
    expect(knowledge.validateDocumentationCoverage?.(collectFieldPaths(fields),docs??[])).toEqual([]);
});
it('rejects a new undocumented leaf even when its parent is already described',()=>{
    const fields=registry.createRegistry(),docs=knowledge.getDocumentationIndex?.(fields)??[],paths=collectFieldPaths(fields);
    const extra={...paths.find(field=>field.path==='settings.requestControls.maxToolRounds')!,path:'settings.requestControls.newUndocumentedLimit'};
    expect(knowledge.validateDocumentationCoverage?.([...paths,extra],docs)??[]).toContainEqual({code:'missing-field',path:'settings.requestControls.newUndocumentedLimit'});
});
it('rejects orphan knowledge, broken dependencies and a mistyped example',()=>{
    const fields=registry.createRegistry(),paths=collectFieldPaths(fields),docs=knowledge.getDocumentationIndex?.(fields)??[];
    const port=docs.find(field=>field.path==='safeGuard.listenPort');
    const changed=[...docs.filter(field=>field.path!=='safeGuard.listenPort'),{...port,path:'safeGuard.listenPort',dependencies:['settings.notReal'],examples:[{value:'not-a-port',when:'test'}]}];
    expect(knowledge.validateDocumentationCoverage?.(paths,changed)??[]).toContainEqual({code:'invalid-example',path:'safeGuard.listenPort'});
    expect(knowledge.validateDocumentationCoverage?.(paths,changed)??[]).toContainEqual({code:'unknown-dependency',path:'safeGuard.listenPort'});
    expect(knowledge.validateDocumentationCoverage?.(paths,[...docs,{...port,path:'settings.deletedField'}])??[]).toContainEqual({code:'orphan-field',path:'settings.deletedField'});
});
it('requires recommendation conditions instead of presenting an unexplained universal value',()=>{
    const fields=registry.createRegistry(),paths=collectFieldPaths(fields),docs=knowledge.getDocumentationIndex?.(fields)??[];
    const modified=docs.map(field=>field.path==='workspace.ragSettings.*.topK'?{...field,recommendation:{value:999,when:''}}:field);
    expect(knowledge.validateDocumentationCoverage?.(paths,modified)??[]).toContainEqual({code:'invalid-recommendation',path:'workspace.ragSettings.*.topK'});
});
it('publishes compact boolean schemas and deduplicated union alternatives',()=>{
    const fields=registry.createRegistry();
    expect(fields.find(field=>field.fieldId==='readingMenus')?.schema.properties?.enabled.type).toBe('boolean');
    const duplicates:string[]=[];
    const walk=(node:any,path:string)=>{
        if(node.anyOf){const serialized=node.anyOf.map((item:unknown)=>JSON.stringify(item));if(new Set(serialized).size!==serialized.length)duplicates.push(path);node.anyOf.forEach((item:any)=>walk(item,path));}
        Object.entries(node.properties??{}).forEach(([key,value])=>walk(value,path+'.'+key));
        if(node.items)walk(node.items,path+'.*');
        if(node.additionalProperties && typeof node.additionalProperties==='object')walk(node.additionalProperties,path+'.*');
    };
    fields.forEach(field=>walk(field.schema,field.moduleId+'.'+field.fieldId));
    expect(duplicates).toEqual([]);
});
it('finds an Ollama address field using user vocabulary rather than a raw property name',async()=>{
    const f=configurationFixture();
    const result:any=await executeConfigurationTool(f.service,'configuration_describe',{query:'Ollama 地址',detail:'summary'});
    expect(result.fields.map((field:any)=>field.path)).toContain('settings.localLlmConfigs.*.baseUrl');
});
it('allows a compact high-risk inventory without returning low-risk fields',async()=>{
    const f=configurationFixture();
    const result:any=await executeConfigurationTool(f.service,'configuration_describe',{risk:['high'],detail:'summary',limit:100});
    expect(result.fields.map((field:any)=>field.path)).toContain('safeGuard.defaultReadOnlyEnabled');
    expect(result.fields.every((field:any)=>field.risk==='high')).toBe(true);
});
it('detects a stale root article even if it is no longer emitted by the schema walker',()=>{
    ROOT_DOCUMENTATION['settings.deletedRoot']={title:'已删除设置',summary:'这个字段已经从结构移除，遗留说明不能继续发布。',userTopic:'first-setup'};
    try{
        const fields=registry.createRegistry(),docs=knowledge.getDocumentationIndex?.(fields)??[];
        expect(knowledge.validateDocumentationCoverage?.(collectFieldPaths(fields),docs)??[]).toContainEqual({code:'orphan-field',path:'settings.deletedRoot'});
    }finally{delete ROOT_DOCUMENTATION['settings.deletedRoot'];}
});
