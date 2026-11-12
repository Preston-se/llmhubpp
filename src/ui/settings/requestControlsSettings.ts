
import { Modal, Notice, Setting } from 'obsidian';
import type { SettingsContext } from './settingsContext';
import type { RequestControls } from 'src/core/requestUsage';
import { settingsText as tr } from './settingsText';
export function displayRequestControls(container:HTMLElement,{plugin,display}:SettingsContext):void{
  const settings=plugin.getRequestControls();
  const save=(updates:Partial<RequestControls>)=>{void plugin.updateRequestControls(updates).then(display).catch(error=>new Notice(error instanceof Error?error.message:String(error)));};
  new Setting(container).setName('保护范围例外').setDesc('首次说明原因并记住选择，更换条件后重新询问。附件外发例外保留费用限制；费用范围例外记为未知，处于硬预算范围之外。')
    .addButton(button=>button.setButtonText('重置已记住的选择').onClick(()=>{
      void plugin.resetRequestProtectionChoices().then(()=>new Notice('已重置，下次遇到时将重新询问')).catch(error=>new Notice(String(error)));
    }));
  container.createEl('p',{text:tr('Controls apply to built-in desktop API requests, including embeddings and tool rounds. External CLI, MCP services and live voice have separate billing. Month boundaries use UTC. Existing unpriced traffic is not assumed free.','管控桌面端内置 API 请求，包含嵌入和工具回合。外部 CLI、MCP 服务及实时语音单独计费；月份按 UTC。未知费用不按免费处理。')});
  const summary=plugin.requestUsage?.summary();
  container.createEl('p',{text:plugin.requestUsageError??(summary?
    tr('This month: ','本月：')+summary.month+' · '+tr('usage-priced ¥','按实报用量计价 ¥')+summary.actualCny.toFixed(4)+' · '+tr('uncertain estimate ¥','未确定估算 ¥')+summary.estimatedCny.toFixed(4)+' · '+tr('reserved ¥','预留 ¥')+summary.reservedCny.toFixed(4)+' · '+tr('unpriced/unknown ','费率或用量未知 ')+summary.unknown:
    tr('Usage ledger is starting.','费用记录正在启动。'))});
  new Setting(container).setName(tr('Monthly hard budget','月度硬预算')).setDesc(tr('Applies to newly managed API attempts after enabling. Enter earlier spending in opening balance. Missing prices or an unbounded paid request are blocked; local origins remain usable.','开启后管控新发出的 API 调用；此前支出请填写月初余额。缺少费率或无法限制费用的请求会被阻止；本地服务继续可用。'))
    .addToggle(toggle=>toggle.setValue(settings.budgetEnabled).onChange(value=>save({budgetEnabled:value})));
  const numeric=(key:'monthlyBudgetCny'|'openingBalanceCny'|'warningRatio'|'maxOutputTokens'|'maxToolRounds'|'maxContextChars',english:string,chinese:string)=>new Setting(container)
    .setName(tr(english,chinese)).addText(text=>text.setValue(String(settings[key])).onChange(value=>{if(value.trim()&&Number.isFinite(Number(value)))save({[key]:Number(value)});}));
  numeric('monthlyBudgetCny','Monthly limit (CNY)','月度上限（人民币）');
  numeric('openingBalanceCny','Earlier spending / opening balance (CNY)','此前支出 / 月初已用金额（人民币）');
  numeric('warningRatio','Warning ratio (0–1)','提醒比例（0–1）');
  numeric('maxOutputTokens','Maximum output tokens under budget','预算管控时的最大输出 Token');
  numeric('maxToolRounds','Maximum provider tool rounds (1–20)','提供方工具回合上限（1–20）');
  numeric('maxContextChars','Remote context character limit (0 keeps current behavior)','远程上下文字符上限（0 沿用原行为）');
  container.createEl('p',{text:tr('Older complete turns are omitted when needed. Local history stays complete; the goal and latest tool-call/result pairs are retained. If these exceed the limit, the request stops. SDK automatic retries are disabled; failed requests can be retried manually.','必要时裁去较早的完整轮次，本地历史保持完整；保留任务目标及最近一轮工具调用与结果。仍超限则停止请求。SDK 自动重试已关闭，失败后可手动重试。')});
  new Setting(container).setName(tr('Outgoing text policy','原文发送策略')).addDropdown(dropdown=>dropdown.addOptions({
    unchanged:tr('Keep existing sending behavior','沿用原发送方式'),
    'local-only':tr('Local origins only','仅允许本地服务'),
    redact:tr('Apply configured redaction rules','按已配置规则脱敏'),
    confirm:tr('Review original payload before each request','每次检查原文后发送'),
  }).setValue(settings.outbound).onChange(value=>save({outbound:value as RequestControls['outbound']})));
  container.createEl('p',{text:tr('Hosted search queries and binary attachment redaction cannot be fully controlled. The first local prompt explains the limitation and remembers your decision for the same service, model and protection settings. Allowed exceptions are outside hard-budget coverage.','托管搜索查询词和附件脱敏无法完整保证。首次本机提示会说明影响，按服务、模型及保护设置记住选择；允许的例外处于硬预算范围之外。')});
  const edit=(key:'rates'|'redactionRules'|'localOrigins',english:string,chinese:string)=>{
    new Setting(container).setName(tr(english,chinese)).addButton(button=>button.setButtonText(tr('Edit JSON','编辑 JSON')).onClick(()=>{
      const modal=new Modal(plugin.app);modal.setTitle(tr(english,chinese));let value=JSON.stringify(settings[key],null,2);
      new Setting(modal.contentEl).addTextArea(area=>{area.inputEl.addClass('llm-hub-rate-editor');area.setValue(value).onChange(text=>{value=text;});});
      new Setting(modal.contentEl).addButton(saveButton=>saveButton.setButtonText(tr('Save','保存')).onClick(()=>{
        void (async()=>{try{const parsed:unknown=JSON.parse(value);await plugin.updateRequestControls({[key]:parsed} as Partial<RequestControls>);modal.close();display();}catch(error){new Notice(error instanceof Error?error.message:String(error));}})();
      }));modal.open();
    }));
  };
  edit('rates','Model rates in CNY per million tokens','模型人民币费率（每百万 Token）');
  container.createEl('pre',{cls:'llm-hub-index-report',text:'[{"origin":"https://your-provider.example","model":"your-model","inputPerMillion":1,"outputPerMillion":2,"version":"your-price-date"}]'});
  container.createEl('p',{text:tr('Optional rates: cachedInputPerMillion, cacheWritePerMillion, searchPerRequest. Rates are user-supplied snapshots; no live prices or currency conversion are assumed.','可选字段：cachedInputPerMillion、cacheWritePerMillion、searchPerRequest。费率由用户填入并注明版本，不假定实时价格或自动汇率。')});
  edit('redactionRules','Text replacement rules','文字脱敏规则');
  container.createEl('pre',{cls:'llm-hub-index-report',text:'[{"pattern":"sensitive literal or regex","replacement":"[redacted]"}]'});
  edit('localOrigins','Explicitly allowed local origins','明确认可的本地服务地址');
  container.createEl('p',{text:tr('Loopback is local by default. Add the origin of your LAN Ollama server, e.g. http://192.168.1.2:11434; authorize only services you consider local and unbilled.','回环地址默认属于本地。局域网 Ollama 请填完整 origin，例如 http://192.168.1.2:11434；只认可你认为属于本地且不计费的服务。')});
  new Setting(container).setName(tr('Request records and totals','请求记录与汇总')).addButton(button=>button.setButtonText(tr('View local records','查看本地记录')).onClick(()=>{
    const modal=new Modal(plugin.app);modal.setTitle(tr('Local request records (no prompts)','本地调用记录（不含提示正文）'));
    const records=plugin.requestUsage?.records()??[],totals:Record<string,{requests:number;pricedCny:number;unknown:number}>={};
    for(const record of records){const key=new Date(record.startedAt).toISOString().slice(0,10)+' · '+record.origin+' · '+record.model,group=totals[key]??{requests:0,pricedCny:0,unknown:0};group.requests++;group.pricedCny+=record.costCny??0;if(record.costCny===null)group.unknown++;totals[key]=group;}
    modal.contentEl.createEl('pre',{cls:'llm-hub-index-report',text:JSON.stringify({byDayAndModel:totals,attempts:records},null,2)});modal.open();
  }));
  new Setting(container).setName(tr('Reconcile an ended or interrupted request','核对已结束或中断的请求')).setDesc(tr('Use the actual provider bill to resolve uncertain reservations. Original records are retained. Running requests cannot be released.','按提供方实际账单核对未确定费用；保留原始记录，运行中的请求不能释放预留。')).addButton(button=>button.setButtonText(tr('Enter billed amount','填写核对金额')).onClick(()=>{
    const modal=new Modal(plugin.app);modal.setTitle(tr('Reconcile billed cost','核对账单金额'));let id='',amount='';
    new Setting(modal.contentEl).setName(tr('Attempt ID','请求 ID')).addText(text=>text.onChange(value=>{id=value;}));
    new Setting(modal.contentEl).setName(tr('Billed amount (CNY)','实际金额（人民币）')).addText(text=>text.onChange(value=>{amount=value;}));
    new Setting(modal.contentEl).addButton(saveButton=>saveButton.setButtonText(tr('Save reconciliation','保存核对结果')).onClick(()=>{
      void (async()=>{try{if(!amount.trim())throw new Error(tr('Enter an amount','请填写金额'));await plugin.requestUsage?.reconcileCost(id.trim(),Number(amount));modal.close();display();}catch(error){new Notice(error instanceof Error?error.message:String(error));}})();
    }));modal.open();
  }));
}
