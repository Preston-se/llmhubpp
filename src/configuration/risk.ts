import type {ConfigOperation,ConfigWarning,RawSnapshot,ConfigDescriptor} from './types';
import {getFieldKnowledge} from './knowledge';
import {DEFAULT_REQUEST_CONTROLS,type RequestControls} from '../core/requestUsage';
export interface ConfigurationRisk{path:string;level:'high';reason:string;helpUri:string}
interface LeafChange{path:string;before:unknown;after:unknown}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function leaves(before:unknown,after:unknown,path:string):LeafChange[]{
 if(same(before,after))return [];
 if(Array.isArray(before)||Array.isArray(after)){
  const old:unknown[]=Array.isArray(before)?before:[],next:unknown[]=Array.isArray(after)?after:[],all=[...old,...next];
  if(all.length&&all.every(item=>item&&typeof item==='object'&&typeof Reflect.get(item,'id')==='string')){
   const previous=old as Record<string,unknown>[],following=next as Record<string,unknown>[];
   return [...new Set([...previous,...following].map(item=>String(item.id)))].flatMap(id=>leaves(previous.find(item=>item.id===id),following.find(item=>item.id===id),path+'.*'));
  }
  return [{path,before,after}];
 }
 if(before&&typeof before==='object'||after&&typeof after==='object'){
  const old=before&&typeof before==='object'?before as Record<string,unknown>:{},next=after&&typeof after==='object'?after as Record<string,unknown>:{};
  return [...new Set([...Object.keys(old),...Object.keys(next)])].flatMap(key=>leaves(old[key],next[key],path+'.'+(path==='resources.files'?'*':key)));
 }
 return [{path,before,after}];
}
function controlRisk(change:LeafChange,before:RawSnapshot,after:RawSnapshot):string|undefined{
 const old={...DEFAULT_REQUEST_CONTROLS,...before.settings.requestControls as Partial<RequestControls>|undefined},next={...DEFAULT_REQUEST_CONTROLS,...after.settings.requestControls as Partial<RequestControls>|undefined};
 const field=change.path.slice('settings.requestControls.'.length);
 if(field==='outbound'){
  if(old.outbound==='unchanged'||next.outbound==='local-only')return;
  return old.outbound==='local-only'?'取消仅本地发送限制，资料可能发送到远端服务。':old.outbound==='confirm'?'取消发送前正文确认；后续请求改用另一种发送保护。':'取消规则脱敏；后续请求可能发送原始文字。';
 }
 if(field==='budgetEnabled')return old.budgetEnabled&&!next.budgetEnabled?'关闭月度硬预算，受管付费请求不再因额度或未知费率而被阻止。':undefined;
 if(field==='localOrigins'){
  const exempted=(controls:RequestControls)=>controls.budgetEnabled||['local-only','confirm'].includes(controls.outbound);
  const builtin=(origin:string)=>{try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname);}catch{return false;}};
  if(exempted(old)&&exempted(next)&&next.localOrigins.some(origin=>!old.localOrigins.includes(origin)&&!builtin(origin)))return '扩大受信本地服务范围；新增 origin 可绕过远端确认、仅本地限制或受管付费预算预检。';
 }
 if(field==='redactionRules'&&old.outbound==='redact'&&next.outbound==='redact'&&old.redactionRules.length)return '修改或移除正在使用的脱敏规则，原有文字保护可能失效；正则与替换顺序无法自动判定强弱。';
 if(old.budgetEnabled&&next.budgetEnabled){
  if(field==='monthlyBudgetCny'&&next.monthlyBudgetCny>old.monthlyBudgetCny)return '提高月度硬预算上限，允许更多受管付费支出。';
  const month=new Date().toISOString().slice(0,7),spent=(controls:RequestControls)=>controls.openingBalanceMonth===month?controls.openingBalanceCny:0;
  if(['openingBalanceCny','openingBalanceMonth'].includes(field)&&spent(next)<spent(old))return '减少本月计入预算的启用前支出，扩大当前可用付费额度；请核对账单。';
 }
 return;
}
export function assessConfigurationRisk(operations:ConfigOperation[],before:RawSnapshot,after:RawSnapshot,registry:ConfigDescriptor[]):ConfigurationRisk[]{
 const risks=new Map<string,ConfigurationRisk>();
 for(const root of new Set(operations.map(op=>op.moduleId+'.'+op.fieldId.split('.')[0]))){
  const [moduleId,fieldId]=root.split('.') as [keyof RawSnapshot,string];
  const changes=leaves(before[moduleId][fieldId],after[moduleId][fieldId],root);
  for(const change of changes){
   let knowledge;try{knowledge=getFieldKnowledge(change.path,registry);}catch{continue;}
   if(knowledge.risk!=='high')continue;
   let reason=knowledge.summary;
   if(change.path.startsWith('settings.requestControls.')){
    const impact=controlRisk(change,before,after);
    if(!impact)continue;
    reason=impact;
   }
   if(change.path==='safeGuard.upstreamBaseUrl'){
    const destination=(value:unknown)=>{if(typeof value!=='string')return '';try{const url=new URL(value);return url.origin+url.pathname.replace(/\/+$/,'')+url.search+url.username+url.password;}catch{return value;}};
    if(destination(change.before)===destination(change.after))continue;
   }
   if(/^safeGuard\.(?:enabled|defaultReadOnlyEnabled|enforceProxyReadOnly)$/.test(change.path)&&change.after!==false)continue;
   if(!change.path.startsWith('safeGuard.')&&/\.(?:autoApprove|enabled)$/.test(change.path)&&change.after!==true)continue;
   if(root==='resources.files'){
    const old=before.resources.files as Record<string,unknown>??{},next=after.resources.files as Record<string,unknown>??{};
    if(!Object.keys(next).some(path=>/\.(?:ps1|py|js|mjs|cjs|sh)$/i.test(path)&&!same(old[path],next[path])))continue;
   }
   if(change.path==='settings.cloudVaultToolAllowedFolders'){
    const old=Array.isArray(change.before)?change.before as string[]:[],next=Array.isArray(change.after)?change.after as string[]:[];
    if(!old.length||next.length&&next.every(folder=>old.some(prior=>folder===prior||folder.startsWith(prior+'/'))))continue;
   }
   risks.set(change.path,{path:change.path,level:'high',reason,helpUri:knowledge.helpUri});
  }
 }
 return [...risks.values()];
}
export function reindexWarnings(before:RawSnapshot,after:RawSnapshot):ConfigWarning[]{
 const old=before.workspace.ragSettings as Record<string,Record<string,unknown>>??{},next=after.workspace.ragSettings as Record<string,Record<string,unknown>>??{};
 return Object.entries(next).flatMap(([name,rag])=>old[name]&&['embeddingModel','embeddingBaseUrl','embeddingProvider','chunkSize','chunkOverlap','pdfChunkPages'].some(key=>!same(old[name][key],rag[key]))?[{code:'REINDEX_REQUIRED',path:'workspace.ragSettings.'+name,message:'嵌入或分块设置已变化，原索引仍保留；需另行决定更新/重建范围，不会自动执行。',fix:'local-index-review'}]:[]);
}
