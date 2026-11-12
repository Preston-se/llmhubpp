import { it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ release: null as null | ((value: unknown) => void) }));
vi.mock('../core/openaiProvider', () => ({ verifyApiProvider: () => new Promise(resolve => { state.release = resolve; }) }));
import { checkConfiguration } from './checks';
it('does not apply a late verification result after the check times out', async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const configuration: any = { host: { settings: { apiProviders: [{ id: 'a', type: 'custom', baseUrl: 'http://test', apiKey: 'key' }] } }, service: { read: async () => ({ revision: 'r' }) }, captureDraft:()=>({base:{},sourceId:'check'}),saveUi: save };
    try {
        const checking = checkConfiguration(configuration, { kind: 'api', targetId: 'a' });
        const rejected = expect(checking).rejects.toMatchObject({ code: 'check-timeout' });
        await vi.advanceTimersByTimeAsync(60001);
        await rejected;
        state.release?.({ success: true, models: ['m'] });
        await vi.runAllTimersAsync();
        expect(save).not.toHaveBeenCalled();
    }
    finally {
        vi.useRealTimers();
    }
});
it('records a private connection attestation and uses the draft captured before the check',async()=>{
 state.release=null;
 const origin={base:{settings:{}},sourceId:'original'},save=vi.fn(),capture=vi.fn(()=>origin);
 const configuration:any={host:{settings:{apiProviders:[{id:'a',type:'custom',baseUrl:'http://test',apiKey:'PRIVATE',verified:false}]}},service:{read:async()=>({revision:'r'})},captureDraft:capture,saveUi:save};
 const checking=checkConfiguration(configuration,{kind:'api',targetId:'a'});
 await vi.waitFor(()=>expect(state.release).toBeTypeOf('function'));state.release?.({success:true,models:['m']});await checking;
 expect(save.mock.calls[0][1].apiProviders[0].verification).toMatchObject({verifiedAt:expect.any(Number),fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
 expect(save.mock.calls[0][2]).toBe(origin);expect(capture).toHaveBeenCalledOnce();
});
it('does not save a check result after concurrent configuration changes',async()=>{
 let revision='r';const save=vi.fn(),configuration:any={host:{settings:{apiProviders:[{id:'a',type:'custom',baseUrl:'http://test',apiKey:'PRIVATE'}]}},service:{read:async()=>({revision})},captureDraft:()=>({base:{},sourceId:'check'}),saveUi:save};
 state.release=null;const checking=checkConfiguration(configuration,{kind:'api',targetId:'a'}),failure=expect(checking).rejects.toMatchObject({code:'conflict'});
 await vi.waitFor(()=>expect(state.release).toBeTypeOf('function'));revision='changed';state.release?.({success:true,models:['m']});await failure;expect(save).not.toHaveBeenCalled();
});
