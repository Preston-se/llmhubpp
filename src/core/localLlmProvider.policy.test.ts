
import { describe,it,expect,afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { memoryVault } from './testSupport/memoryVault';
import { RequestUsageLedger, DEFAULT_REQUEST_CONTROLS } from './requestUsage';
import { configureRequestCapture } from './outboundRequest';
import { localLlmChatStream } from './localLlmProvider';
Object.assign(window,{require:createRequire(import.meta.url)});
afterEach(()=>configureRequestCapture(undefined));
describe('configured local-provider outbound policy',()=>{
  it('blocks a non-local host before the shared transport sends the user message',async()=>{
    const v=memoryVault(),settings={...DEFAULT_REQUEST_CONTROLS,outbound:'local-only' as const};
    const ledger=new RequestUsageLedger(v.io as never,'Usage',()=>settings);await ledger.initialize();
    configureRequestCapture({ledger,settings:()=>settings,confirm:async()=>false});
    const chunks=[];
    for await(const chunk of localLlmChatStream({framework:'ollama',baseUrl:'https://blocked.invalid',model:'m'} as any,[{role:'user',content:'synthetic private text',timestamp:1}],''))chunks.push(chunk);
    expect(chunks.some(chunk=>chunk.type==='error'&&chunk.error?.includes('仅本地'))).toBe(true);
    expect(ledger.records()).toHaveLength(0);
  });
});
