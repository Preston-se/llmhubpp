
import { type RequestControls, RequestUsageLedger, type UsageCounts, validateRequestControls, DEFAULT_REQUEST_CONTROLS } from './requestUsage';
import type { ProtectionException } from './requestProtectionChoices';
interface CaptureHost {ledger:RequestUsageLedger;settings():RequestControls;confirm(origin:string,payload:string):Promise<boolean>;exception?(scope:ProtectionException):Promise<boolean>;warn?(text:string):void}
let host:CaptureHost|undefined;
const remoteContextBounds=new Map<string,number>();
export function configureRequestCapture(value:CaptureHost|undefined):void {host=value;remoteContextBounds.clear();}
export function requestToolRoundLimit():number{return host?validateRequestControls(host.settings()).maxToolRounds:DEFAULT_REQUEST_CONTROLS.maxToolRounds;}
const marker=Symbol('llmhubpp-request-capture');
interface RequestLabels {sessionId?:string;purpose?:string;delegated?:boolean;model?:string}
export async function authorizeDelegatedRequest(origin:string,model:string):Promise<void> {
  if(!host)return;
  const settings=validateRequestControls(host.settings());
  if(!await host.exception?.({origin,model,reason:'delegated-service',settingsKey:JSON.stringify(settings)}))
    throw new Error('OpenCode 可自行调用远端模型和工具，插件无法保证后续隐私或费用；本次未发送');
}
type Json=Record<string,unknown>;
const object=(value:unknown):Json=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Json:{};
export function prepareRemoteContext(body:Json,limit:number):Json {
  const result=structuredClone(body);if(!limit||JSON.stringify(result).length<=limit)return result;
  const key=Array.isArray(result.messages)?'messages':Array.isArray(result.contents)?'contents':Array.isArray(result.input)?'input':null;
  if(!key)throw new Error('请求超过上下文预算，请分段发送');
  const messages=result[key] as Json[],groups:Json[][]=[],pinned:Json[]=[];
  for(const message of messages){
    if(message.role==='system'||message.role==='developer'){pinned.push(message);continue;}
    const toolResult=Array.isArray(message.content)&&message.content.some(part=>object(part).type==='tool_result');
    if((message.role==='user'&&!toolResult)||!groups.length)groups.push([]);
    groups[groups.length-1].push(message);
  }
  if(!groups.length)throw new Error('请求超过上下文预算');
  const selected=[groups[groups.length-1]],goal=groups[0][0]?.role==='user'?groups[0][0]:undefined;
  const compose=()=>[...pinned,...(goal&&selected[0][0]!==goal?[goal]:[]),...selected.flat()];
  result[key]=compose();
  if(JSON.stringify(result).length>limit)throw new Error('任务目标与最近一轮超过上下文预算，请缩短输入或分段读取资料');
  for(let index=groups.length-2;index>=0;index--){
    selected.unshift(groups[index]);result[key]=compose();
    if(JSON.stringify(result).length>limit){selected.shift();result[key]=compose();break;}
  }
  return result;
}
export function isLocalRequestOrigin(origin:string,settings:RequestControls):boolean {
  const hostname=new URL(origin).hostname.toLowerCase();
  return ['localhost','127.0.0.1','[::1]'].includes(hostname)||settings.localOrigins.includes(origin);
}
function hostedSearch(body:Json):boolean {
  return JSON.stringify(body.tools??[]).match(/"(?:web_search(?:_preview|_20\d+)?|googleSearch|google_search|urlContext|url_context)"/i)!==null;
}
function containsAttachment(value:unknown):boolean {
  if(Array.isArray(value))return value.some(containsAttachment);
  if(!value||typeof value!=='object')return false;
  const record=object(value);
  if(typeof record.type==='string'&&['input_file','input_image','input_audio','image','document','file','audio','video'].includes(record.type))return true;
  return Object.entries(record).some(([key,item])=>['inlineData','inline_data','image_url','file_data','input_audio','images','base64'].includes(key)||containsAttachment(item));
}
function redact(value:unknown,settings:RequestControls):unknown {
  if(typeof value==='string')return settings.redactionRules.reduce((text,rule)=>text.replace(new RegExp(rule.pattern,'g'),rule.replacement),value);
  if(Array.isArray(value))return value.map(item=>redact(item,settings));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,['data','inlineData','inline_data','image_url','file_data','input_audio','images','base64'].includes(key)||(key==='url'&&typeof item==='string'&&item.startsWith('data:'))?item:redact(item,settings)]));
  return value;
}
function capOutput(body:Json,path:string,cap:number):number {
  const limit=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?Math.min(value,cap):cap;
  if(/embed/i.test(path))return 0;
  if(/\/chat\/completions/.test(path)){const key=body.max_completion_tokens!==undefined?'max_completion_tokens':'max_tokens',value=limit(body[key]);body[key]=value;return value;}
  if(/\/responses/.test(path)){const value=limit(body.max_output_tokens);body.max_output_tokens=value;return value;}
  if(/\/messages/.test(path)){const value=limit(body.max_tokens);body.max_tokens=value;return value;}
  if(/generateContent/.test(path)){const config=object(body.generationConfig),value=limit(config.maxOutputTokens);body.generationConfig={...config,maxOutputTokens:value};return value;}
  if(/\/interactions/.test(path)){const config=object(body.generation_config),value=limit(config.max_output_tokens);body.generation_config={...config,max_output_tokens:value};return value;}
  throw new Error('该付费接口无法可靠限制最大输出；硬预算已阻止请求');
}
function normalizeUsage(raw:unknown,previous:Partial<UsageCounts>,searchEvents:Set<string>):Partial<UsageCounts> {
  const json=object(raw),u=object(json.usage??json.usageMetadata??object(json.interaction).usage??object(json.metadata).total_usage??object(json.response).usage??object(json.message).usage??object(json.message).usageMetadata);
  const n=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
  const merge=(key:keyof UsageCounts,value:unknown)=>{const number=n(value);if(number!==undefined)previous[key]=Math.max(previous[key]??0,number);};
  if(u){
    const google=u.promptTokenCount!==undefined||u.candidatesTokenCount!==undefined;
    const cache=n(u.total_cached_tokens??u.cachedContentTokenCount??u.cache_read_input_tokens??object(u.prompt_tokens_details).cached_tokens??object(u.input_tokens_details).cached_tokens)??0;
    const write=n(u.cache_creation_input_tokens)??0;
    const input=n(u.total_input_tokens??u.prompt_tokens??u.input_tokens??u.promptTokenCount);
    merge('input',input===undefined?undefined:input+('cache_read_input_tokens' in u?cache+write:0));
    const thought=n(u.thoughtsTokenCount)??0,output=n(u.total_output_tokens??u.completion_tokens??u.output_tokens??u.candidatesTokenCount);
    merge('output',output===undefined?undefined:output+(google?thought:0));
    merge('cachedInput',cache);merge('cacheWrite',write);merge('reasoning',u.total_thought_tokens??u.thoughtsTokenCount??object(u.completion_tokens_details).reasoning_tokens??object(u.output_tokens_details).reasoning_tokens);
    merge('searchRequests',object(u.server_tool_use).web_search_requests??object(u.server_side_tool_usage).web_search);
  }
  const searchSummary=object(json.server_side_tool_usage??object(json.response).server_side_tool_usage??u.server_side_tool_usage);
  merge('searchRequests',searchSummary.SERVER_SIDE_TOOL_WEB_SEARCH??searchSummary.web_search);
  if(json.type==='response.web_search_call.completed'){
    const id=json.item_id??json.id;
    searchEvents.add(typeof id==='string'?id:'anonymous-'+searchEvents.size);
    merge('searchRequests',searchEvents.size);
  }
  for(const candidate of Array.isArray(json.candidates)?json.candidates:[]){const queries=object(object(candidate).groundingMetadata).webSearchQueries;if(Array.isArray(queries))merge('searchRequests',queries.length);}
  return previous;
}
/** Preflight model requests before reserving usage. Read usage as the client consumes the response. */
export function captureRequests(fetcher:typeof fetch,labels?:RequestLabels):typeof fetch {
  const existing=(fetcher as typeof fetch&{[marker]?:{raw:typeof fetch}})[marker];
  if(existing&&!labels)return fetcher;
  if(existing)fetcher=existing.raw;
  const wrapped:typeof fetch=async(input,init)=>{
    const current=host;if(!current)return fetcher(input,init);
    const request=typeof input==='object'&&'url' in input?input:undefined;
    const url=new URL(request?.url??(typeof input==='string'?input:(input as URL).href)),method=(init?.method??request?.method??'GET').toUpperCase();
    const settings=structuredClone(validateRequestControls(current.settings())),local=isLocalRequestOrigin(url.origin,settings);
    const settingsKey=JSON.stringify(settings);
    const exceptions:string[]=[];
    const permit=async(reason:string,message:string,model=labels?.model??'unknown')=>{
      if(!await current.exception?.({origin:url.origin,model,reason,settingsKey}))throw new Error(message);
      exceptions.push(reason);
    };
    if(labels?.delegated)await permit('delegated-service','外部服务的后续隐私与费用无法管控，本次未发送');
    if(settings.outbound==='local-only'&&!local&&!labels?.delegated)throw new Error('当前为仅本地发送策略，已阻止远程请求');
    if(method!=='POST'||(!labels?.delegated&&!/chat\/completions|\/api\/chat|\/responses|\/messages|generateContent|embedContent|\/embeddings|\/interactions|\/images|\/audio|:predict|\/api\/v1\/decide|\/api\/alpha\/decisions/i.test(url.pathname)))return fetcher(input,init);
    const raw=init?.body??(request?await request.clone().text():undefined);
    const text=typeof raw==='string'?raw:raw?await new Response(raw).text():'';
    let parsed:Json|undefined;
    try{const value:unknown=JSON.parse(text);if(value&&typeof value==='object'&&!Array.isArray(value))parsed=object(value);}catch{/* Non-JSON endpoints cannot be safely rewritten. */}
    const model=labels?.model??(typeof parsed?.model==='string'?parsed.model:url.pathname.match(/\/models\/([^/:]+)/)?.[1]??'unknown');
    if(!parsed&&(settings.budgetEnabled||(!local&&settings.outbound!=='unchanged')))await permit('unknown-payload','此接口的二进制或未知请求无法预检；未发送受控请求',model);
    let outgoing=parsed;
    if(outgoing&&(!local||labels?.delegated)){
      if(hostedSearch(outgoing)&&(settings.outbound!=='unchanged'||settings.budgetEnabled))await permit('hosted-search','托管联网搜索无法逐词预检或限定费用，已禁用本次搜索；请使用可检查查询词的入口',model);
      outgoing=prepareRemoteContext(outgoing,settings.maxContextChars);
      if(settings.outbound==='redact'){
        if(containsAttachment(outgoing))await permit('attachment-redaction','附件无法通过文字规则可靠脱敏，请改用确认原文或本地模式',model);
        outgoing=redact(outgoing,settings) as Json;
      }
    }
    let maxOutput=settings.maxOutputTokens,priorBound=0;
    const previous=outgoing?.previous_response_id??outgoing?.previous_interaction_id;
    if(settings.budgetEnabled&&!local&&previous){
      const bound=typeof previous==='string'?remoteContextBounds.get(url.origin+'/'+previous):undefined;
      if(bound===undefined)await permit('remote-history','远程续接历史的输入费用无法可靠预留；请开始新会话后使用硬预算',model);
      priorBound=bound??0;
    }
    const unbounded=()=>exceptions.some(reason=>reason!=='attachment-redaction');
    if(settings.budgetEnabled&&!local&&outgoing&&!unbounded()){
      try{maxOutput=capOutput(outgoing,url.pathname,settings.maxOutputTokens);}catch{await permit('output-bound','该接口无法可靠限制最大输出；硬预算已阻止请求',model);}
    }
    const payload=outgoing?JSON.stringify(outgoing):text;
    const signal=init?.signal??request?.signal;
    // A prompt or a ledger write can outlive the policy it was evaluated under.
    // Check cancellation and the same policy again before sending any payload.
    const checkDispatch=()=>{
      if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
      if(host!==current||settingsKey!==JSON.stringify(validateRequestControls(current.settings())))throw new Error('请求保护设置已变更，请按新设置重新发送');
    };
    checkDispatch();
    if((!local||labels?.delegated)&&settings.outbound==='confirm'&&!await current.confirm(url.origin,payload))throw new Error('已取消发送原文');
    checkDispatch();
    const purpose=/embed/i.test(url.pathname)?'embedding':/images|audio|predict/i.test(url.pathname)?'media':/interactions/i.test(url.pathname)?'interaction':'chat-or-workflow';
    const estimatedInput=new TextEncoder().encode(payload).length+priorBound;
    const attempt=await current.ledger.reserve({origin:url.origin,model:model.slice(0,256),purpose:labels?.purpose??purpose,sessionId:labels?.sessionId,estimatedInput,maxOutput,local:local&&!labels?.delegated,protectionExceptions:exceptions.length?exceptions:undefined,unboundedCost:unbounded()||undefined});
    if(current.ledger.summary().warning)current.warn?.('费用预算已达到提醒阈值');
    let dispatched=false,finished=false,responseId:string|undefined,terminal=false,providerError=false;const counts:Partial<UsageCounts>={},searchEvents=new Set<string>();
    const inspectUsage=(raw:unknown)=>{const json=object(raw),id=object(json.interaction).id??object(json.response).id??json.id;if(typeof id==='string')responseId=id;
      if(json.error||['error','response.failed','response.incomplete'].includes(typeof json.type==='string'?json.type:''))providerError=true;
      const event=json.type??json.event_type;
      if(event==='interaction.failed'||object(json.interaction).status==='failed')providerError=true;
      if(['message_stop','response.completed','interaction.complete','interaction.completed'].includes(typeof event==='string'?event:'')||(Array.isArray(json.candidates)&&json.candidates.some(candidate=>!!object(candidate).finishReason)))terminal=true;
      normalizeUsage(raw,counts,searchEvents);};
    const finish=async(outcome:'completed'|'failed'|'cancelled')=>{
      if(finished)return;finished=true;
      const usage=counts.input!==undefined&&(counts.output!==undefined||purpose==='embedding')?{...counts,input:counts.input,output:counts.output??0} as UsageCounts:undefined;
      await current.ledger.settle(attempt.attemptId,outcome,usage,dispatched);
      if(outcome==='completed'&&responseId)remoteContextBounds.set(url.origin+'/'+responseId,Math.max(estimatedInput+maxOutput,(counts.input??0)+(counts.output??0)));
    };
    const aborted=()=>{void finish('cancelled').catch(()=>current.warn?.('费用记录保存失败，已保留预留额度'));};
    signal?.addEventListener('abort',aborted,{once:true});
    try{
      checkDispatch();
      dispatched=true;
      const response=await fetcher(input,{...init,...(parsed?{body:payload}:{})});
      if(!response.body){await finish(response.ok?'completed':'failed');signal?.removeEventListener('abort',aborted);return response;}
      const reader=response.body.getReader(),decoder=new TextDecoder(),isSse=response.headers.get('Content-Type')?.includes('text/event-stream');
      let buffer='',overflow=false;
      const inspect=(chunk:Uint8Array|undefined,final=false)=>{
        buffer+=decoder.decode(chunk,{stream:!final});
        if(buffer.length>1048576){overflow=true;buffer='';return;}
        if(isSse){
          const lines=buffer.split('\n');buffer=final?'':lines.pop()??'';
          for(const line of lines){const value=line.trim().replace(/^data:\s*/,'');if(value==='[DONE]'){terminal=true;continue;}if(!value)continue;try{inspectUsage(JSON.parse(value));}catch{/* incomplete/non-data SSE line */}}
        }else if(final&&!overflow){try{const data:unknown=JSON.parse(buffer);for(const item of Array.isArray(data)?data:[data])inspectUsage(item);}catch{/* Unknown usage remains unknown. */}}
      };
      const body=new ReadableStream<Uint8Array>({
        async pull(controller){try{const item=await reader.read();inspect(item.value,item.done);if(item.done){await finish(response.ok&&!providerError&&(!isSse||terminal)?'completed':'failed');signal?.removeEventListener('abort',aborted);controller.close();}else controller.enqueue(item.value);}catch(error){await finish(signal?.aborted?'cancelled':'failed');signal?.removeEventListener('abort',aborted);controller.error(error);}},
        async cancel(reason){try{await reader.cancel(reason);}finally{await finish('cancelled');signal?.removeEventListener('abort',aborted);}},
      });
      const result=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      Object.defineProperty(result,'url',{value:response.url});
      return result;
    }catch(error){await finish(!dispatched||signal?.aborted?'cancelled':'failed');signal?.removeEventListener('abort',aborted);throw error;}
  };
  Object.defineProperty(wrapped,marker,{value:{raw:fetcher}});return wrapped;
}
