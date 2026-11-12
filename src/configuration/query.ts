import type { ConfigurationService } from './service';
import { ConfigurationError } from './types';
import { blockedKeys } from './validation';
import { assertConfigurationModules, collectFieldPaths, findFieldPath, type FieldPath } from './schemaPaths';
import { getDocumentationIndex, type FieldKnowledge } from './knowledge';
import { modelReferenceWarnings } from './diagnostics';
export { assertConfigurationModules, collectFieldPaths, findFieldPath } from './schemaPaths';
export type { FieldPath } from './schemaPaths';
function requestedFields(service: ConfigurationService,args: Record<string, unknown>): (FieldPath&{canonicalPath:string})[] {
    const modules = args.modules as string[] | undefined;
    assertConfigurationModules(modules);
    const fields = collectFieldPaths(service.describe(modules));
    if (args.fieldPaths !== undefined) {
        if (!Array.isArray(args.fieldPaths) || !args.fieldPaths.length || args.fieldPaths.length>32 || args.fieldPaths.some(path=>typeof path!=='string')) throw new ConfigurationError('invalid-arguments',[],{parameter:'fieldPaths',maximum:32});
        return [...new Set(args.fieldPaths as string[])].map(path=>{
            const field=findFieldPath(fields,path);
            if (!field) throw new ConfigurationError('unknown-field',[],{didYouMean:fields.filter(candidate=>candidate.path.split('.').at(-1)===path.split('.').at(-1)).slice(0,5).map(candidate=>candidate.path)});
            return {...field,canonicalPath:field.path,path};
        });
    }
    return fields.filter(field=>field.path===field.root).map(field=>({...field,canonicalPath:field.path}));
}
function page<T>(rows:T[],args:Record<string,unknown>):{items:T[];nextCursor?:string} {
    if (args.limit!==undefined && (!Number.isInteger(args.limit) || Number(args.limit)<1 || Number(args.limit)>100)) throw new ConfigurationError('invalid-arguments',[],{parameter:'limit',minimum:1,maximum:100});
    if (args.cursor!==undefined && (typeof args.cursor!=='string'||!/^\d{1,8}$/.test(args.cursor))) throw new ConfigurationError('invalid-arguments',[],{parameter:'cursor'});
    const start=Number(args.cursor??0),limit=Number(args.limit??20);
    return {items:rows.slice(start,start+limit),...(start+limit<rows.length?{nextCursor:String(start+limit)}:{})};
}
function entityIdentity(value:unknown):string|undefined {
    const id:unknown=value && typeof value==='object'?Reflect.get(value,'id'):undefined;
    return typeof id==='string'?id:undefined;
}
function project(value:unknown,parts:string[],canonicalParts:string[]):unknown {
    if (!parts.length) return value===undefined?null:value;
    if (value && typeof value==='object' && !Array.isArray(value) && typeof Reflect.get(value,'configured')==='boolean') return value;
    const [part,...rest]=parts;
    const [canonical,...canonicalRest]=canonicalParts;
    if (part==='*') {
        if (Array.isArray(value)) return (value as unknown[]).map(item=>({...(entityIdentity(item)!==undefined?{entityId:entityIdentity(item)}:{}),value:project(item,rest,canonicalRest)}));
        if (value && typeof value==='object') return Object.entries(value).filter(([key])=>!blockedKeys.has(key)).map(([entityId,item])=>({entityId,value:project(item,rest,canonicalRest)}));
        return [];
    }
    if (Array.isArray(value)) {
        const item:unknown=(value as unknown[]).find(item=>entityIdentity(item)===part);
        if (item===undefined) throw new ConfigurationError('entity-not-found',[],{availableEntityIds:(value as unknown[]).flatMap(item=>entityIdentity(item)!==undefined?[entityIdentity(item)]:[])});
        return project(item,rest,canonicalRest);
    }
    if(canonical==='*'&&(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,part)))throw new ConfigurationError('entity-not-found',[],{availableEntityIds:value&&typeof value==='object'?Object.keys(value).filter(key=>!blockedKeys.has(key)):[]});
    return project(value && typeof value==='object'?Reflect.get(value,part):undefined,rest,canonicalRest);
}
function isEmpty(value:unknown):boolean {
    return value===null || value===undefined || Array.isArray(value) && !value.length || !!value && typeof value==='object' && !Object.keys(value).length;
}
export async function queryConfiguration(service:ConfigurationService,args:Record<string,unknown>):Promise<object> {
    if (args.detail!==undefined && args.detail!=='summary' && args.detail!=='full') throw new ConfigurationError('invalid-arguments',[],{parameter:'detail'});
    const fields=requestedFields(service,args),all=await service.read(),warnings=modelReferenceWarnings(all.modules);
    const snapshot={revision:all.revision,modules:Object.fromEntries(Object.entries(all.modules).filter(([key])=>args.modules===undefined||(args.modules as string[]).includes(key)))};
    if (args.fieldPaths===undefined && args.detail===undefined && args.limit===undefined && args.cursor===undefined) return {...snapshot,warnings,empty:Object.values(snapshot.modules).every(isEmpty)};
    const selected=page(fields,args),values=Object.fromEntries(selected.items.map(field=>[field.path,project(snapshot.modules,field.path.split('.'),field.canonicalPath.split('.'))]));
    return {revision:snapshot.revision,values,warnings,empty:Object.values(values).every(isEmpty),...('nextCursor' in selected && selected.nextCursor?{nextCursor:selected.nextCursor}:{})};
}
export function describeConfiguration(service:ConfigurationService,args:Record<string,unknown>):object {
    if (args.detail!==undefined && args.detail!=='summary' && args.detail!=='full') throw new ConfigurationError('invalid-arguments',[],{parameter:'detail'});
    let fields:FieldPath[]=requestedFields(service,args);
    const descriptors=service.describe(args.modules as string[]|undefined),allFields=collectFieldPaths(descriptors);
    const knowledge=new Map(getDocumentationIndex(descriptors).map(field=>[field.path,field]));
    const metadata=(field:FieldPath):FieldKnowledge=>{
        const found=knowledge.get(field.path)??knowledge.get(findFieldPath(allFields,field.path)?.path??'');
        if(!found)throw new ConfigurationError('documentation-missing',[],{path:field.path});
        return found;
    };
    if(args.fieldPaths===undefined && (args.query!==undefined || args.risk!==undefined))fields=allFields;
    if (args.query!==undefined) {
        if(typeof args.query!=='string'||args.query.length>200) throw new ConfigurationError('invalid-arguments',[],{parameter:'query'});
        const terms=args.query.toLowerCase().split(/\s+/).filter(Boolean);
        fields=fields.filter(field=>{const info=metadata(field);const text=[field.path,field.description,info.title,info.summary,...info.keywords].join(' ').toLowerCase();return terms.every(term=>text.includes(term));});
    }
    if(args.risk!==undefined){
        if(!Array.isArray(args.risk)||!args.risk.length||args.risk.some(value=>!['low','medium','high'].includes(String(value))))throw new ConfigurationError('invalid-arguments',[],{parameter:'risk'});
        const risks=args.risk as string[];fields=fields.filter(field=>risks.includes(metadata(field).risk));
    }
    if (args.fieldPaths===undefined && args.detail===undefined && args.query===undefined && args.risk===undefined && args.limit===undefined && args.cursor===undefined) return {fields:descriptors};
    const selected=page(fields,args);
    return {fields:selected.items.map(field=>args.detail==='full'?field:{
        path:field.path,moduleId:field.moduleId,fieldId:field.fieldId,type:field.schema.type??'union',readOnly:field.readOnly,sensitive:field.sensitive,effect:field.effect,
        ...(field.schema.enum?{enum:field.schema.enum}:{}),...(field.path===field.root && field.defaultValue!==undefined?{default:field.defaultValue}:{}),
        ...compactKnowledge(metadata(field)),
    }),...(selected.nextCursor?{nextCursor:selected.nextCursor}:{}),empty:!selected.items.length};
}
function compactKnowledge(knowledge:FieldKnowledge):object{
    return {title:knowledge.title,summary:knowledge.summary.slice(0,120),risk:knowledge.risk,unit:knowledge.unit,helpUri:knowledge.helpUri,
        ...(knowledge.recommendation?{recommendation:knowledge.recommendation}:{}),impacts:knowledge.impacts};
}
