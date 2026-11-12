
import { describe,it,expect } from 'vitest';
import { memoryVault } from './testSupport/memoryVault';
import { RequestUsageLedger, DEFAULT_REQUEST_CONTROLS } from './requestUsage';
function fixture() {
  const v=memoryVault(),settings={...DEFAULT_REQUEST_CONTROLS,budgetEnabled:true,monthlyBudgetCny:1,rates:[{origin:'https://paid.example',model:'m',inputPerMillion:10,outputPerMillion:10,version:'user-1'}]};
  const ledger=new RequestUsageLedger(v.io as never,'Logs',()=>settings,()=>Date.UTC(2026,10,8));
  const input={origin:'https://paid.example',model:'m',purpose:'chat',estimatedInput:10000,maxOutput:50000};
  return {v,settings,ledger,input};
}
describe('local request usage and reservations',()=>{
  it('does not insert a future active reservation into an earlier monthly report',async()=>{
    const f=fixture();await f.ledger.initialize();await f.ledger.reserve(f.input);expect(f.ledger.summary('2026-10').requests).toBe(0);
  });
  it('keeps an earlier invoice in its original month when reconciled later',async()=>{
    const f=fixture();let time=Date.UTC(2026,9,15);const ledger=new RequestUsageLedger(f.v.io as never,'Months',()=>f.settings,()=>time);await ledger.initialize();const record=await ledger.reserve(f.input);await ledger.settle(record.attemptId,'cancelled');time=Date.UTC(2026,10,8);
    await ledger.reconcileCost(record.attemptId,.1);expect(ledger.summary('2026-10').actualCny).toBeCloseTo(.1);expect(ledger.summary('2026-11').actualCny).toBe(0);
  });
  it('serializes simultaneous reservations at the hard cap and restores unfinished ones after restart',async()=>{
    const f=fixture();await f.ledger.initialize();
    const results=await Promise.allSettled([f.ledger.reserve(f.input),f.ledger.reserve(f.input)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const restored=new RequestUsageLedger(f.v.io as never,'Logs',()=>f.settings,()=>Date.UTC(2026,10,8));
    await restored.initialize();expect(restored.summary().reservedCny).toBeCloseTo(.6);
    await expect(restored.reserve(f.input)).rejects.toThrow(/预算/);
  });
  it('reconciles usage without charging cached or reasoning token subsets twice and deduplicates settlement',async()=>{
    const f=fixture();await f.ledger.initialize();
    const record=await f.ledger.reserve({...f.input,maxOutput:10000});
    const counts={input:1000,output:500,cachedInput:800,reasoning:300,searchRequests:0};
    await f.ledger.settle(record.attemptId,'completed',counts);await f.ledger.settle(record.attemptId,'completed',counts);
    expect(f.ledger.records()).toHaveLength(1);expect(f.ledger.summary().actualCny).toBeCloseTo(.015);
    expect(f.ledger.records()[0].measurement).toBe('actual');
  });
  it('blocks missing prices under a hard budget, preserves uncertain cancellation charges and starts a new month cleanly',async()=>{
    const f=fixture();await f.ledger.initialize();
    await expect(f.ledger.reserve({...f.input,model:'unpriced'})).rejects.toThrow(/费率/);
    const record=await f.ledger.reserve(f.input);await f.ledger.settle(record.attemptId,'cancelled');
    expect(f.ledger.summary().estimatedCny).toBeCloseTo(.6);expect(f.ledger.records()[0].measurement).toBe('unknown');
    const next=new RequestUsageLedger(f.v.io as never,'Logs',()=>f.settings,()=>Date.UTC(2026,11,1));await next.initialize();
    expect(next.summary().reservedCny+next.summary().estimatedCny).toBe(0);
  });
  it('records an unpriced request as unknown when hard control is off and stores no request or credential text',async()=>{
    const f=fixture();f.settings.budgetEnabled=false;await f.ledger.initialize();
    const record=await f.ledger.reserve({...f.input,model:'unpriced'});await f.ledger.settle(record.attemptId,'failed');
    expect(f.ledger.records()[0].costCny).toBeNull();expect(f.ledger.summary().unknown).toBe(1);
    expect([...f.v.files.values()].join('')).not.toContain('apiKey');
  });
  it('keeps the full reservation after cancellation with partial usage and carries active work across a month boundary',async()=>{
    const f=fixture();await f.ledger.initialize();const record=await f.ledger.reserve(f.input);
    await f.ledger.settle(record.attemptId,'cancelled',{input:10,output:2});
    expect(f.ledger.summary().budgetUsedCny).toBeCloseTo(.6);
    const active=fixture();await active.ledger.initialize();await active.ledger.reserve(active.input);
    const next=new RequestUsageLedger(active.v.io as never,'Logs',()=>active.settings,()=>Date.UTC(2026,11,1));await next.initialize();
    expect(next.summary().budgetUsedCny).toBeCloseTo(.6);
  });
  it('lets an explicit invoice reconciliation resolve a stranded reservation without deleting its original evidence',async()=>{
    const f=fixture();await f.ledger.initialize();const record=await f.ledger.reserve(f.input);
    await f.ledger.settle(record.attemptId,'cancelled');
    await f.ledger.reconcileCost(record.attemptId,.1);
    expect(f.ledger.summary().budgetUsedCny).toBeCloseTo(.1);
    const restored=new RequestUsageLedger(f.v.io as never,'Logs',()=>f.settings,()=>Date.UTC(2026,10,8));await restored.initialize();
    expect(restored.summary().actualCny).toBeCloseTo(.1);
    expect([...f.v.files.keys()].filter(path=>path.endsWith('.json'))).toHaveLength(3);
  });
});
