
import type { DataAdapter } from 'obsidian';
import { randomUUID } from 'crypto';
import { ensureStorageDirectory } from './storagePaths';
export interface RequestRate {
  origin:string; model:string; inputPerMillion:number; outputPerMillion:number;
  cachedInputPerMillion?:number; cacheWritePerMillion?:number; searchPerRequest?:number; version:string;
}
export interface RequestControls {
  budgetEnabled:boolean; monthlyBudgetCny:number; warningRatio:number; openingBalanceCny:number;
  openingBalanceMonth?:string;
  maxOutputTokens:number; maxToolRounds:number; maxContextChars:number;
  outbound:'unchanged'|'local-only'|'redact'|'confirm';
  localOrigins:string[]; redactionRules:Array<{pattern:string;replacement:string}>;
  rates:RequestRate[];
}
export const DEFAULT_REQUEST_CONTROLS:RequestControls={
  budgetEnabled:false,monthlyBudgetCny:300,warningRatio:.8,openingBalanceCny:0,maxOutputTokens:4096,
  maxToolRounds:20,maxContextChars:0,outbound:'unchanged',localOrigins:[],redactionRules:[],rates:[],
};
export interface UsageCounts {input:number;output:number;cachedInput?:number;cacheWrite?:number;reasoning?:number;searchRequests?:number}
export interface AttemptInput {origin:string;model:string;purpose:string;sessionId?:string;estimatedInput:number;maxOutput:number;searchRequests?:number;local?:boolean;protectionExceptions?:string[];unboundedCost?:boolean}
export interface UsageAttempt extends AttemptInput {
  attemptId:string;startedAt:number;finishedAt?:number;month:string;
  outcome:'reserved'|'completed'|'failed'|'cancelled'|'interrupted';measurement:'actual'|'estimated'|'unknown';
  reservedCny:number|null;costCny:number|null;currency:'CNY';rate?:RequestRate;counts?:UsageCounts;covered:boolean;
  costBasis?:'manual-reconciliation';
  reconciledAt?:number;
  reconciliationRevision?:number;
}
const monthAt=(time:number)=>new Date(time).toISOString().slice(0,7);
function validCounts(counts:UsageCounts):boolean {
  return Object.values(counts).every(value=>value===undefined||(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0))
    &&Number.isSafeInteger(counts.input)&&Number.isSafeInteger(counts.output)
    &&(counts.cachedInput??0)+(counts.cacheWrite??0)<=counts.input&&(counts.reasoning??0)<=counts.output;
}
function cost(counts:UsageCounts,rate:RequestRate):number|null {
  if(!validCounts(counts))return null;
  if((counts.cacheWrite??0)>0&&rate.cacheWritePerMillion===undefined)return null;
  if((counts.searchRequests??0)>0&&rate.searchPerRequest===undefined)return null;
  const cached=counts.cachedInput??0,write=counts.cacheWrite??0;
  return ((counts.input-cached-write)*rate.inputPerMillion+cached*(rate.cachedInputPerMillion??rate.inputPerMillion)
    +write*(rate.cacheWritePerMillion??rate.inputPerMillion)+counts.output*rate.outputPerMillion)/1000000
    +(counts.searchRequests??0)*(rate.searchPerRequest??0);
}
export function validateRequestControls(raw:Partial<RequestControls>|undefined):RequestControls {
  const value={...DEFAULT_REQUEST_CONTROLS,...raw};
  if(![value.monthlyBudgetCny,value.openingBalanceCny,value.warningRatio,value.maxOutputTokens,value.maxToolRounds,value.maxContextChars].every(n=>typeof n==='number'&&Number.isFinite(n))
    ||value.monthlyBudgetCny<=0||value.openingBalanceCny<0||value.warningRatio<=0||value.warningRatio>1
    ||!Number.isInteger(value.maxOutputTokens)||value.maxOutputTokens<1||value.maxOutputTokens>1000000
    ||!Number.isInteger(value.maxToolRounds)||value.maxToolRounds<1||value.maxToolRounds>20
    ||!Number.isInteger(value.maxContextChars)||value.maxContextChars<0
    ||!['unchanged','local-only','redact','confirm'].includes(value.outbound))throw new Error('调用控制配置无效');
  if(!Array.isArray(value.rates)||!Array.isArray(value.localOrigins)||!Array.isArray(value.redactionRules))throw new Error('费率或发送策略配置无效');
  for(const rate of value.rates){
    if(typeof rate.origin!=='string'||new URL(rate.origin).origin!==rate.origin||!rate.model||!rate.version
      ||![rate.inputPerMillion,rate.outputPerMillion,rate.cachedInputPerMillion??0,rate.cacheWritePerMillion??0,rate.searchPerRequest??0].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))
      throw new Error('请提供合法的服务、模型及人民币费率');
  }
  for(const origin of value.localOrigins)if(new URL(origin).origin!==origin)throw new Error('本地服务必须填写完整 origin');
  for(const rule of value.redactionRules){if(typeof rule.pattern!=='string'||typeof rule.replacement!=='string'||!rule.pattern)throw new Error('脱敏规则无效');new RegExp(rule.pattern,'g');}
  return value;
}
export class RequestUsageLedger {
  private entries=new Map<string,UsageAttempt>();
  private tail=Promise.resolve();
  private ready=false;
  constructor(private readonly io:DataAdapter,readonly directory:string,private readonly settings:()=>RequestControls,private readonly now:()=>number=Date.now){}
  private async serial<T>(work:()=>Promise<T>):Promise<T>{
    const before=this.tail;let release!:()=>void;this.tail=new Promise<void>(resolve=>{release=resolve;});await before;
    try{return await work();}finally{release();}
  }
  async initialize():Promise<void>{
    if(await this.io.exists(this.directory)){
      const paths=(await this.io.list(this.directory)).files.filter(path=>/\/[a-f0-9-]+-(reserved|settled|reconciled)(?:-\d+-[a-f0-9-]+)?\.json$/.test(path)).sort();
      for(const path of paths){
        const record=JSON.parse(await this.io.read(path)) as UsageAttempt;
        if(!/^[a-f0-9-]{36}$/.test(record.attemptId)||typeof record.startedAt!=='number'||!Number.isFinite(record.startedAt)
          ||record.month!==monthAt(record.startedAt)||record.currency!=='CNY'||![record.reservedCny,record.costCny].every(n=>n===null||(typeof n==='number'&&Number.isFinite(n)&&n>=0))
          ||!['reserved','completed','failed','cancelled','interrupted'].includes(record.outcome))throw new Error('本地费用记录损坏，已保留记录并阻止受控请求');
        const previous=this.entries.get(record.attemptId);
        const rank=(item:UsageAttempt)=>item.costBasis==='manual-reconciliation'?2:item.outcome==='reserved'?0:1;
        if(!previous||rank(record)>rank(previous)||(rank(record)===rank(previous)&&((record.reconciliationRevision??0)>(previous.reconciliationRevision??0)
          ||((record.reconciliationRevision??0)===(previous.reconciliationRevision??0)&&(record.reconciledAt??record.finishedAt??record.startedAt)>=(previous.reconciledAt??previous.finishedAt??previous.startedAt)))))this.entries.set(record.attemptId,record);
      }
      for(const [id,record] of this.entries)if(record.outcome==='reserved')this.entries.set(id,{...record,outcome:'interrupted',measurement:'unknown'});
    }
    this.ready=true;
  }
  private async save(record:UsageAttempt,phase:'reserved'|'settled'|'reconciled'):Promise<void>{
    await ensureStorageDirectory(this.io,this.directory);
    const path=this.directory+'/'+record.attemptId+'-'+phase+'-'+this.now()+'-'+randomUUID()+'.json',text=JSON.stringify(record);
    await this.io.write(path+'.tmp',text);
    if(await this.io.read(path+'.tmp')!==text)throw new Error('费用记录写入失败，未发送请求');
    await this.io.rename(path+'.tmp',path);
  }
  records():UsageAttempt[]{return [...this.entries.values()].map(value=>structuredClone(value));}
  summary(month=monthAt(this.now())):{
    month:string;actualCny:number;estimatedCny:number;reservedCny:number;unknown:number;requests:number;budgetUsedCny:number;warning:boolean;
  }{
    const s=validateRequestControls(this.settings()),result={month,actualCny:0,estimatedCny:0,reservedCny:0,unknown:0,requests:0,budgetUsedCny:s.openingBalanceCny,warning:false};
    result.budgetUsedCny=s.openingBalanceMonth===month?s.openingBalanceCny:0;
    for(const record of this.entries.values())if((record.finishedAt?monthAt(record.finishedAt):record.month)===month||(['reserved','interrupted'].includes(record.outcome)&&record.month<=month)){
      result.requests++;
      const value=record.costCny??record.reservedCny??0;
      if(record.outcome==='reserved'||record.outcome==='interrupted')result.reservedCny+=value;
      else if(record.measurement==='actual')result.actualCny+=value;
      else result.estimatedCny+=value;
      if(record.costCny===null)result.unknown++;
      if(record.covered)result.budgetUsedCny+=value;
    }
    result.warning=result.budgetUsedCny>=s.monthlyBudgetCny*s.warningRatio;
    return result;
  }
  async reserve(input:AttemptInput):Promise<UsageAttempt>{
    return this.serial(async()=>{
      if(!this.ready)throw new Error('费用记录未就绪，未发送请求');
      const s=validateRequestControls(this.settings());
      const rate=s.rates.find(rate=>rate.origin===input.origin&&rate.model===input.model);
      const maximum=Math.max(rate?.inputPerMillion??0,rate?.cachedInputPerMillion??0,rate?.cacheWritePerMillion??0);
      const reserved=input.local?0:rate?cost({input:input.estimatedInput,output:input.maxOutput,searchRequests:input.searchRequests??0},{...rate,inputPerMillion:maximum}):null;
      const excepted=!!input.unboundedCost;
      if(s.budgetEnabled&&!input.local&&!excepted){
        if(!rate||reserved===null)throw new Error('硬预算需要完整费率；未发送该请求');
        if(this.summary().budgetUsedCny+reserved>s.monthlyBudgetCny)throw new Error('月度预算不足，已阻止新付费请求');
      }
      const startedAt=this.now();
      const record:UsageAttempt={...input,attemptId:randomUUID(),startedAt,month:monthAt(startedAt),outcome:'reserved',
        measurement:'unknown',reservedCny:excepted?null:reserved,costCny:null,currency:'CNY',rate:rate?structuredClone(rate):undefined,covered:s.budgetEnabled&&!input.local&&!excepted};
      await this.save(record,'reserved');this.entries.set(record.attemptId,record);return structuredClone(record);
    });
  }
  async settle(id:string,outcome:'completed'|'failed'|'cancelled',counts?:UsageCounts,dispatched=true):Promise<void>{
    await this.serial(async()=>{
      const previous=this.entries.get(id);if(!previous||!['reserved','interrupted'].includes(previous.outcome))return;
      const valid=!previous.unboundedCost&&counts&&validCounts(counts)?counts:undefined;
      const amount=!dispatched||previous.local?0:outcome==='completed'&&valid&&previous.rate?cost(valid,previous.rate):null;
      const record:UsageAttempt={...previous,outcome,finishedAt:this.now(),counts:valid,measurement:!dispatched||outcome==='completed'&&valid?'actual':'unknown',costCny:amount};
      await this.save(record,'settled');this.entries.set(id,record);
    });
  }
  async reconcileCost(id:string,amountCny:number):Promise<void>{
    await this.serial(async()=>{
      const previous=this.entries.get(id);
      if(!previous||previous.outcome==='reserved'||!Number.isFinite(amountCny)||amountCny<0)throw new Error('只能核对已结束或已中断的请求，请填写有效 ID 和金额');
      const record:UsageAttempt={...previous,outcome:'completed',measurement:'actual',costCny:amountCny,costBasis:'manual-reconciliation',finishedAt:previous.finishedAt??previous.startedAt,reconciledAt:this.now(),reconciliationRevision:(previous.reconciliationRevision??0)+1};
      await this.save(record,'reconciled');this.entries.set(id,record);
    });
  }
}
