import { afterEach, expect, it, vi } from 'vitest';
const wire=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('obsidian',async original=>({...await original<typeof import('obsidian')>(),requestUrl:wire.request}));
vi.mock('./localLlmProvider',async()=>({...await import('obsidian-llm-hub-common/core'),getHttpModule:()=>({request:()=>({on(){return this;},end(){},destroy(){}})})}));
import { opencodeLocalChatStream } from './opencodeLocalProvider';
import { configureRequestCapture } from './outboundRequest';
import { DEFAULT_REQUEST_CONTROLS, RequestUsageLedger } from './requestUsage';
import { memoryVault } from './testSupport/memoryVault';
afterEach(()=>{configureRequestCapture(undefined);vi.clearAllMocks();});
async function setup(allowed:boolean){
  const settings={...DEFAULT_REQUEST_CONTROLS,outbound:'local-only' as const},ledger=new RequestUsageLedger(memoryVault().io as never,'usage',()=>settings);
  await ledger.initialize();const exception=vi.fn(async()=>allowed);
  configureRequestCapture({ledger,settings:()=>settings,confirm:async()=>true,exception});
  wire.request.mockImplementation(async({url}:any)=>url.endsWith('/session')?{status:200,json:{id:'session'},text:'{"id":"session"}'}:{status:200,json:{parts:[{type:'text',text:'ok'}]},text:'{"parts":[{"type":"text","text":"ok"}]}'});
  return {ledger,exception};
}
async function run(){
  const image={type:'image' as const,name:'test.png',mimeType:'image/png',data:'aW1hZ2U='};const result=[];
  for await(const c of opencodeLocalChatStream({baseUrl:'https://synthetic.invalid',model:'provider/model'} as any,[{role:'user',content:'question',timestamp:0}], '',undefined,[image]))result.push(c);
  return result;
}
it('blocks before sessions or message transport when the user rejects limited protection',async()=>{
  const f=await setup(false);const chunks=await run();expect(wire.request).not.toHaveBeenCalled();expect(f.exception).toHaveBeenCalled();expect(chunks.some(c=>c.type==='error')).toBe(true);
});
it('forwards an image and records delegated billing as unknown after explicit permission',async()=>{
  const f=await setup(true);const chunks=await run();
  const message=wire.request.mock.calls.find(([r])=>r.url.endsWith('/message'))?.[0];
  expect(JSON.parse(message.body).parts).toContainEqual({type:'file',mime:'image/png',filename:'test.png',url:'data:image/png;base64,aW1hZ2U='});
  expect(f.ledger.records()[0]).toMatchObject({covered:false,costCny:null,measurement:'unknown'});
  expect(chunks.some(c=>c.type==='done')).toBe(true);
});
