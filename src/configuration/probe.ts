import type { LlmHubSettings } from '../types';
import { createNodeFetch, createProxyFetch } from '../core/proxyFetch';
import { isLocalRequestOrigin } from '../core/outboundRequest';
import { DEFAULT_REQUEST_CONTROLS, validateRequestControls } from '../core/requestUsage';
import { ConfigurationError } from './types';

type ProbeKind='ollama'|'openai-compatible'|'mcp-http';
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function candidate(value:unknown):URL {
    try {
        if(typeof value!=='string')throw new Error('Invalid URL');
        const url=new URL(value);
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid URL');
        return url;
    }catch{throw new ConfigurationError('invalid-arguments');}
}
function credentialHeaders(settings:LlmHubSettings,url:URL,ref:unknown):Headers {
    const headers=new Headers();
    if(ref===undefined)return headers;
    const r=object(ref);
    if(typeof r.id!=='string'||!['api','local','mcp'].includes(String(r.kind))||Object.keys(r).some(k=>!['id','kind'].includes(k)))throw new ConfigurationError('invalid-arguments');
    const entity= r.kind==='api'?settings.apiProviders.find(x=>x.id===r.id):r.kind==='local'?settings.localLlmConfigs.find(x=>x.id===r.id):settings.mcpServers.find(x=>Reflect.get(x,'id')===r.id||x.name===r.id);
    if(!entity)throw new ConfigurationError('entity-not-found');
    const e=entity as unknown as Record<string,unknown>,stored=candidate(e.baseUrl??e.url);
    if(stored.origin!==url.origin)throw new ConfigurationError('credential-origin-mismatch');
    if(r.kind==='mcp'){
        if(e.transport==='stdio'||!e.url)throw new ConfigurationError('invalid-arguments');
        for(const [key,value]of Object.entries(object(e.headers)))if(typeof value==='string')headers.set(key,value);
    }else if(typeof e.username==='string'&&e.username){
        const bytes=new TextEncoder().encode(e.username+':'+(typeof e.password==='string'?e.password:''));
        headers.set('Authorization','Basic '+btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join('')));
    }else if(typeof e.apiKey==='string'&&e.apiKey)headers.set('Authorization','Bearer '+e.apiKey);
    return headers;
}
async function readBounded(response:Response,signal:AbortSignal,sse=false):Promise<string>{
    if(!response.body)return '';
    const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,body='';
    let abort:()=>void=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{abort=()=>{void reader.cancel().catch(()=>{});reject(new DOMException('Aborted','AbortError'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    try{
        for(;;){const {done,value}=await Promise.race([reader.read(),cancelled]);if(done)break;size+=value.byteLength;
            if(size>1024*1024){await reader.cancel();throw new ConfigurationError('upstream-response-too-large');}
            body+=decoder.decode(value,{stream:true});
            if(sse){let boundary:RegExpExecArray|null;while((boundary=/\r?\n\r?\n/.exec(body))){
                const event=body.slice(0,boundary.index);body=body.slice(boundary.index+boundary[0].length);
                if(event.split(/\r?\n/).some(line=>line.startsWith('data:'))&&parseBody(event,true).id===1){await reader.cancel();return event;}
            }}}
        return body+decoder.decode();
    }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
function parseBody(text:string,sse:boolean):Record<string,unknown>{
    try {
        const raw=sse?text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n'):text;
        const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid metadata');
        return value as Record<string,unknown>;
    }catch{throw new ConfigurationError('invalid-upstream-response');}
}
/** One explicit HTTP target; only model metadata or MCP initialization, never persistence or inference. */
export async function probeEndpoint(host:{settings:LlmHubSettings},args:Record<string,unknown>,external?:AbortSignal):Promise<Record<string,unknown>>{
    if(Object.keys(args).some(k=>!['kind','url','credentialRef','timeoutMs'].includes(k))||!['ollama','openai-compatible','mcp-http'].includes(String(args.kind)))throw new ConfigurationError('invalid-arguments');
    const kind=args.kind as ProbeKind,url=candidate(args.url),controls=validateRequestControls(host.settings.requestControls??DEFAULT_REQUEST_CONTROLS);
    if(controls.outbound==='local-only'&&!isLocalRequestOrigin(url.origin,controls))throw new ConfigurationError('outbound-policy');
    const timeout=args.timeoutMs===undefined?10000:args.timeoutMs;
    if(typeof timeout!=='number'||!Number.isInteger(timeout)||timeout<100||timeout>60000)throw new ConfigurationError('invalid-arguments');
    const headers=credentialHeaders(host.settings,url,args.credentialRef);
    const path=url.pathname.replace(/\/+$/,'');
    if(kind==='ollama')url.pathname=path.endsWith('/api/tags')?path:path.endsWith('/api')?path+'/tags':path+'/api/tags';
    if(kind==='openai-compatible')url.pathname=path.endsWith('/models')?path:path.endsWith('/v1')?path+'/models':path+'/v1/models';
    if(kind==='mcp-http'&&/chat\/completions|\/responses|generateContent|\/embeddings|\/messages$|\/api\/chat/.test(path))throw new ConfigurationError('invalid-arguments');
    const fetcher=host.settings.proxyUrl?createProxyFetch(host.settings.proxyUrl,host.settings.proxyBypass):createNodeFetch();
    const controller=new AbortController(),start=Date.now();let timedOut=false;
    const abort=()=>controller.abort();external?.addEventListener('abort',abort,{once:true});if(external?.aborted)abort();
    const timer=window.setTimeout(()=>{timedOut=true;abort();},timeout);
    const request=async(method:string,body?:unknown)=>{
        if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
        const response=await fetcher(url.href,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,redirect:'error'});
        if(response.status===401||response.status===403){await response.body?.cancel();throw new ConfigurationError('upstream-unauthorized',[],{status:response.status});}
        if(!response.ok){await response.body?.cancel();throw new ConfigurationError('upstream-http-error',[],{status:response.status});}
        return response;
    };
    try {
        if(kind==='mcp-http'){
            headers.set('Content-Type','application/json');headers.set('Accept','application/json, text/event-stream');
            const response=await request('POST',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'llmhubpp-configuration-probe',version:'1.1'}}});
            const sse=response.headers.get('content-type')?.includes('text/event-stream')===true;
            const payload=parseBody(await readBounded(response,controller.signal,sse),sse),result=object(payload.result);
            if(payload.id!==1||payload.error||typeof result.protocolVersion!=='string'||!['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(result.protocolVersion)||!result.capabilities)throw new ConfigurationError('invalid-upstream-response');
            headers.set('MCP-Protocol-Version',result.protocolVersion);
            const session=response.headers.get('mcp-session-id');if(session)headers.set('Mcp-Session-Id',session);
            try{await (await request('POST',{jsonrpc:'2.0',method:'notifications/initialized'})).body?.cancel();}
            finally{if(session&&!controller.signal.aborted)try{await (await fetcher(url.href,{method:'DELETE',headers,signal:controller.signal,redirect:'error'})).body?.cancel();}catch{/* Session cleanup is best effort and never persisted. */}}
            return {success:true,kind,scope:'handshake-only',protocolVersion:result.protocolVersion,capabilities:Object.keys(object(result.capabilities)).filter(x=>['tools','resources','prompts','logging','completions'].includes(x)),elapsedMs:Date.now()-start};
        }
        const response=await request('GET'),payload=parseBody(await readBounded(response,controller.signal),false),rows=kind==='ollama'?payload.models:payload.data;
        if(!Array.isArray(rows)||rows.some(row=>typeof object(row)[kind==='ollama'?'name':'id']!=='string'))throw new ConfigurationError('invalid-upstream-response');
        const models=Array.from(new Set(rows.map(row=>String(object(row)[kind==='ollama'?'name':'id'])).filter(name=>name.length>0&&name.length<=256)));
        return {success:true,kind,scope:'metadata-only',models:models.slice(0,100),modelCount:models.length,truncated:models.length>100,elapsedMs:Date.now()-start};
    }catch(error){
        if(timedOut)throw new ConfigurationError('probe-timeout');
        if(external?.aborted)throw new ConfigurationError('probe-cancelled');
        if(error instanceof ConfigurationError)throw error;
        throw new ConfigurationError('upstream-unreachable');
    }finally{window.clearTimeout(timer);external?.removeEventListener('abort',abort);}
}
