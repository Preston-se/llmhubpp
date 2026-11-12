
import { describe,it,expect,vi,afterEach } from 'vitest';
import { memoryVault } from './testSupport/memoryVault';
import { RequestUsageLedger, DEFAULT_REQUEST_CONTROLS } from './requestUsage';
import { configureRequestCapture, captureRequests, prepareRemoteContext } from './outboundRequest';
function fixture(overrides:any={}) {
  const v=memoryVault(),settings={...DEFAULT_REQUEST_CONTROLS,...overrides};
  const ledger=new RequestUsageLedger(v.io as never,'Usage',()=>settings);
  const confirm=vi.fn(async()=>true);
  configureRequestCapture({ledger,settings:()=>settings,confirm});
  return {v,settings,ledger,confirm};
}
afterEach(()=>configureRequestCapture(undefined));
const body={model:'m',messages:[{role:'user',content:'PRIVATE 123'}],stream:true};
const request=(data:any=body)=>({method:'POST',body:JSON.stringify(data)});
describe('outbound API policy and attempt capture',()=>{
  it.each(['audio','video'])('blocks encoded Gemini %s bytes under text redaction',async type=>{
    const f=fixture({outbound:'redact'});await f.ledger.initialize();const wire=vi.fn();
    await expect(captureRequests(wire as any)('https://paid.example/v1beta/interactions',request({model:'m',input:[{type,data:'PRIVATE-BYTES'}]}))).rejects.toThrow(/附件/);
    expect(wire).not.toHaveBeenCalled();
  });
  it('counts xAI search summaries once when individual events also arrive',async()=>{
    const f=fixture({rates:[{origin:'https://paid.example',model:'m',version:'test',inputPerMillion:1,outputPerMillion:1,searchPerRequest:5}]});await f.ledger.initialize();
    const events=[{type:'response.web_search_call.completed',item_id:'a'},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:2},server_side_tool_usage:{SERVER_SIDE_TOOL_WEB_SEARCH:2}}}];
    const wire=vi.fn(async()=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}}));
    await (await captureRequests(wire as any)('https://paid.example/v1/responses',request())).text();
    expect(f.ledger.records()[0].counts?.searchRequests).toBe(2);expect(f.ledger.records()[0].costCny).toBeGreaterThanOrEqual(10);
  });
  it('refuses a context cap that would orphan an Anthropic tool result',()=>{
    const data={model:'m',messages:[{role:'user',content:'goal'},{role:'assistant',content:[{type:'text',text:'x'.repeat(800)},{type:'tool_use',id:'call',name:'read',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'result'}]}]};
    expect(()=>prepareRemoteContext(data,400)).toThrow(/预算/);
  });
  it('honors an explicit exception but reports its cost as unknown and outside hard budget',async()=>{
    const f=fixture({outbound:'redact',budgetEnabled:true});await f.ledger.initialize();
    const exception=vi.fn(async()=>true);
    configureRequestCapture({ledger:f.ledger,settings:()=>f.settings,confirm:f.confirm,exception});
    const wire=vi.fn(async()=>new Response(JSON.stringify({usage:{input_tokens:1,output_tokens:1}})));
    await (await captureRequests(wire as any)('https://paid.example/v1/audio/generation',request({model:'m',input:[{type:'audio',data:'bytes'}]}))).text();
    expect(exception).toHaveBeenCalled();expect(wire).toHaveBeenCalledOnce();
    expect(f.ledger.records()[0]).toMatchObject({covered:false,measurement:'unknown',costCny:null});
    expect(f.ledger.records()[0].protectionExceptions?.length).toBeGreaterThan(0);
  });
  it('cancels before dispatch if protection changes while an exception prompt is open',async()=>{
    const f=fixture({outbound:'redact'});await f.ledger.initialize();
    configureRequestCapture({ledger:f.ledger,settings:()=>f.settings,confirm:f.confirm,exception:async()=>{f.settings.outbound='local-only';return true;}});
    const wire=vi.fn(async()=>new Response('{}'));
    await expect(captureRequests(wire as any)('https://paid.example/v1beta/interactions',request({model:'m',input:[{type:'audio',data:'bytes'}]}))).rejects.toThrow(/变更/);
    expect(wire).not.toHaveBeenCalled();
  });
  it('keeps hard-budget coverage for a privacy-only attachment exception',async()=>{
    const f=fixture({outbound:'redact',budgetEnabled:true,rates:[{origin:'https://paid.example',model:'m',inputPerMillion:1,outputPerMillion:2,version:'test'}]});await f.ledger.initialize();
    configureRequestCapture({ledger:f.ledger,settings:()=>f.settings,confirm:f.confirm,exception:async()=>true});
    const wire=vi.fn(async()=>new Response(JSON.stringify({usage:{input_tokens:10,output_tokens:1}})));
    await (await captureRequests(wire as any)('https://paid.example/v1/responses',request({model:'m',input:[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]}))).text();
    expect(f.ledger.records()[0]).toMatchObject({covered:true,measurement:'actual'});expect(f.ledger.records()[0].costCny).not.toBeNull();
    expect(JSON.parse(wire.mock.calls[0][1].body).max_output_tokens).toBe(f.settings.maxOutputTokens);
  });
  it('cancels a queued confirmation before calling a noncancellable transport',async()=>{
    const f=fixture({outbound:'confirm'});await f.ledger.initialize();const controller=new AbortController(),wire=vi.fn(async()=>new Response('{}'));
    f.confirm.mockImplementation(async()=>{controller.abort();return true;});
    await expect(captureRequests(wire as any)('https://paid.example/v1/responses',{...request(),signal:controller.signal})).rejects.toThrow(/取消|abort/i);
    expect(wire).not.toHaveBeenCalled();
  });
  it('rechecks protection after asynchronous reservation persistence',async()=>{
    const f=fixture();await f.ledger.initialize();const rename=f.v.io.rename;
    f.v.io.rename=async(a,b)=>{await rename(a,b);if(b.includes('reserved'))f.settings.outbound='local-only';};
    const wire=vi.fn(async()=>new Response('{}'));
    await expect(captureRequests(wire as any)('https://paid.example/v1/responses',request())).rejects.toThrow(/变更/);
    expect(wire).not.toHaveBeenCalled();expect(f.ledger.records()[0].outcome).toBe('cancelled');expect(f.ledger.records()[0].costCny).toBe(0);
  });
  it('settles actual Gemini completion usage and retains its ID for bounded continuation',async()=>{
    const f=fixture({budgetEnabled:true,rates:[{origin:'https://paid.example',model:'m',version:'test',inputPerMillion:1,outputPerMillion:2}]});await f.ledger.initialize();
    const wire=vi.fn(async()=>new Response('data: '+JSON.stringify({event_type:'interaction.completed',interaction:{id:'g1',status:'completed',usage:{total_input_tokens:10,total_output_tokens:2}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}}));
    const send=captureRequests(wire as any);
    await(await send('https://paid.example/v1beta/interactions',request({model:'m',input:'hello',stream:true}))).text();
    expect(f.ledger.records()[0]).toMatchObject({outcome:'completed',measurement:'actual',counts:{input:10,output:2},covered:true});
    await(await send('https://paid.example/v1beta/interactions',request({model:'m',input:'followup',previous_interaction_id:'g1',stream:true}))).text();
    expect(wire).toHaveBeenCalledTimes(2);
  });
  it('preserves an allowed opaque media data URL under redaction rules',async()=>{
    const f=fixture({outbound:'redact',redactionRules:[{pattern:'aW1h',replacement:'MASKED'}]});await f.ledger.initialize();
    configureRequestCapture({ledger:f.ledger,settings:()=>f.settings,confirm:f.confirm,exception:async()=>true});
    const wire=vi.fn(async()=>new Response('{}'));
    await(await captureRequests(wire as any)('https://paid.example/v1/responses',request({model:'m',input:[{type:'file',url:'data:image/png;base64,aW1hZ2U='}]}))).text();
    expect(wire.mock.calls[0][1].body).toContain('aW1hZ2U=');
  });
  it('blocks OpenAI PDF attachments under redact and Jev decisions under local-only before dispatch',async()=>{
    const f=fixture({outbound:'redact'});await f.ledger.initialize();const wire=vi.fn(),wrapped=captureRequests(wire as any);
    await expect(wrapped('https://paid.example/v1/responses',request({model:'m',input:[{role:'user',content:[{type:'input_file',file_data:'data:application/pdf;base64,SECRET'}]}]}))).rejects.toThrow(/附件/);
    f.settings.outbound='local-only';
    await expect(wrapped('https://api.jev.ai/api/v1/decide',request({query:'private',chunks:['vault text']}))).rejects.toThrow(/本地/);
    expect(wire).not.toHaveBeenCalled();
  });
  it('retains the reservation when a 200 SSE stream ends with partial usage and a provider error',async()=>{
    const f=fixture({budgetEnabled:true,rates:[{origin:'https://paid.example',model:'m',inputPerMillion:1,outputPerMillion:2,version:'test'}]});await f.ledger.initialize();
    const wire=vi.fn(async()=>new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',{headers:{'Content-Type':'text/event-stream'}}));
    await (await captureRequests(wire as any)('https://paid.example/v1/messages',request())).text();
    expect(f.ledger.records()[0].measurement).toBe('unknown');expect(f.ledger.records()[0].costCny).toBeNull();
  });
  it('previews the exact payload and sends zero requests when original-text confirmation is cancelled',async()=>{
    const f=fixture({outbound:'confirm'});await f.ledger.initialize();f.confirm.mockResolvedValue(false);
    const wire=vi.fn();await expect(captureRequests(wire as any)('https://paid.example/v1/chat/completions',request())).rejects.toThrow(/取消/);
    expect(wire).not.toHaveBeenCalled();expect(f.ledger.records()).toHaveLength(0);
    expect(f.confirm.mock.calls[0]).toEqual(['https://paid.example',JSON.stringify(body)]);
  });
  it('redacts before dispatch, fails closed for invalid rules and disables unpreviewable hosted searches',async()=>{
    const f=fixture({outbound:'redact',redactionRules:[{pattern:'PRIVATE',replacement:'[redacted]'}]});await f.ledger.initialize();
    const wire=vi.fn(async(_url:any,init:any)=>new Response(JSON.stringify({usage:{prompt_tokens:10,completion_tokens:2}}),{headers:{'Content-Type':'application/json'}}));
    await (await captureRequests(wire as any)('https://paid.example/v1/chat/completions',request())).json();
    expect(wire.mock.calls[0][1].body).not.toContain('PRIVATE');
    f.settings.redactionRules=[{pattern:'[',replacement:''}];
    await expect(captureRequests(wire as any)('https://paid.example/v1/chat/completions',request())).rejects.toThrow();
    f.settings.redactionRules=[];wire.mockClear();
    await expect(captureRequests(wire as any)('https://paid.example/v1/responses',request({...body,tools:[{type:'web_search'}]}))).rejects.toThrow(/逐词/);
    expect(wire).not.toHaveBeenCalled();
  });
  it('captures streamed usage across chunks without storing payload text and counts reasoning/cache as subsets',async()=>{
    const f=fixture();await f.ledger.initialize();
    const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30},"completion_tokens_details":{"reasoning_tokens":10}}}\n'));c.enqueue(new TextEncoder().encode('\ndata: [DONE]\n\n'));c.close();}});
    const wire=vi.fn(async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}}));
    const response=await captureRequests(wire as any)('https://paid.example/v1/chat/completions',request());
    await response.text();
    expect(f.ledger.records()[0].counts).toMatchObject({input:100,output:20,cachedInput:30,reasoning:10});
    expect([...f.v.files.values()].join('')).not.toContain('PRIVATE');
  });
  it('enforces local-only without blocking explicitly configured local model origins',async()=>{
    const f=fixture({outbound:'local-only',localOrigins:['http://192.168.10.1:11434']});await f.ledger.initialize();
    const wire=vi.fn(async()=>new Response('{}',{headers:{'Content-Type':'application/json'}})),wrapped=captureRequests(wire as any);
    await expect(wrapped('https://paid.example/v1/chat/completions',request())).rejects.toThrow(/本地/);
    await (await wrapped('http://192.168.10.1:11434/v1/chat/completions',request())).text();expect(wire).toHaveBeenCalledTimes(1);
  });
  it('trims only complete old turns and preserves the latest tool-call/result pair without mutating history',()=>{
    const messages=[{role:'system',content:'Goal: solve task'},{role:'user',content:'Original task'}, {role:'assistant',content:'x'.repeat(5000)}, {role:'user',content:'latest'}, {role:'assistant',tool_calls:[{id:'c',type:'function',function:{name:'read_note',arguments:'{}'}}]}, {role:'tool',tool_call_id:'c',content:'evidence'}];
    const original=JSON.stringify(messages),result=prepareRemoteContext({messages},1000);
    expect(JSON.stringify(result)).toContain('"tool_call_id":"c"');expect(JSON.stringify(result)).not.toContain('x'.repeat(100));
    expect(JSON.stringify(messages)).toBe(original);
  });
});
