import { Modal, Notice, Setting } from 'obsidian';
import type { RagSetting } from 'src/types';
import { t } from 'src/i18n';
import { ConfirmModal } from 'src/ui/components/ConfirmModal';
import type { SettingsContext } from './settingsContext';
import { isRagIndexIdleSeconds, RAG_INDEX_IDLE_DEFAULT_SECONDS, RAG_INDEX_IDLE_MAX_SECONDS, RAG_INDEX_IDLE_MIN_SECONDS } from 'src/types';
import { settingsText as tr } from './settingsText';

export function displayRagIdleSettings(container: HTMLElement, {plugin, display}: SettingsContext): void {
  let seconds = plugin.settings.ragIndexIdleSeconds ?? RAG_INDEX_IDLE_DEFAULT_SECONDS;
  const setting = new Setting(container).setName(tr('Wait after editing (seconds)', '编辑后等待（秒）'))
    .setDesc(tr('Each note waits independently. Default: 600 seconds. Enter a whole number from 5 to 900.', '每篇笔记独立计时。默认 600 秒，请输入 5–900 的整数。'));
  setting.addText(text => {
    text.setValue(String(seconds)).onChange(value => { seconds = value.trim() ? Number(value) : NaN; });
    text.inputEl.type = 'number';
    text.inputEl.min = String(RAG_INDEX_IDLE_MIN_SECONDS);
    text.inputEl.max = String(RAG_INDEX_IDLE_MAX_SECONDS);
    text.inputEl.step = '1';
  }).addButton(button => button.setButtonText(tr('Save', '保存')).onClick(async () => {
    if (!isRagIndexIdleSeconds(seconds)) {
      new Notice(tr('Enter a whole number from 5 to 900.', '请输入 5–900 的整数。'));
      return;
    }
    const previous = plugin.settings.ragIndexIdleSeconds;
    plugin.settings.ragIndexIdleSeconds = seconds;
    try { await plugin.saveSettings(); plugin.ragLifecycle?.refreshIdlePolicy(); }
    catch { plugin.settings.ragIndexIdleSeconds = previous; new Notice(tr('Could not save the wait time.', '无法保存等待时间。')); }
  }));
  new Setting(container).setName(tr('Allow waiting after closing a note', '关闭笔记后允许继续等待'))
    .setDesc(tr('When closing the last tab for a note, you can start a new wait from that moment.', '关闭笔记最后一个页签时，可以从选择时重新计时。'))
    .addToggle(toggle => toggle.setValue(plugin.settings.ragContinueAfterClose).onChange(async value => {
      const previous = plugin.settings.ragContinueAfterClose;
      plugin.settings.ragContinueAfterClose = value;
      try { await plugin.saveSettings(); }
      catch { plugin.settings.ragContinueAfterClose = previous; display(); new Notice(tr('Could not save the index setting.', '无法保存索引设置。')); }
    }));
}

export function displayRagLifecycleSettings(container: HTMLElement, context: SettingsContext, name: string, setting: RagSetting): void {
  const {plugin,display}=context, lifecycle=plugin.ragLifecycle;
  if(!lifecycle||setting.externalIndexPath||setting.sourceRagSettings.length||setting.sourceCollection)return;
  new Setting(container).setName(t('index.auto')).setDesc(t('index.autoDescription')).addToggle(toggle=>toggle.setValue(setting.autoUpdateIndex===true).onChange(async enabled=>{
    await plugin.updateRagSetting(name,{autoUpdateIndex:enabled});display();
  }));
  const connection = plugin.indexDestinationStatus(name);
  if (connection === 'choose') new Setting(container).setName(tr('Remote index updates', '远程索引更新'))
    .setDesc(tr('Review the destination before indexing note content.', '索引笔记前，请先选择是否向该服务发送内容。'))
    .addButton(button => button.setButtonText(tr('Review destination', '查看并选择')).onClick(async () => {
      try { await plugin.chooseIndexDestination(name); display(); }
      catch { new Notice(tr('Could not save the index choice.', '无法保存索引选择。')); }
    }));
  if (connection === 'blocked' || connection === 'unavailable') container.createEl('p', { text: connection === 'blocked'
    ? tr('Remote indexing is paused by your sending choices.', '发送设置已暂停远程索引。')
    : tr('Configure an embedding connection to start indexing.', '请配置嵌入服务后开始索引。') });
  const status=container.createDiv();
  const render=()=>{
    const current=lifecycle.status(name);
    const next = current.nextReadyAt ? ' · ' + tr('Next', '最早') + ' ' + new Date(current.nextReadyAt).toLocaleTimeString() : '';
    status.setText(`${t('index.status')} · ${tr('Waiting', '等待')} ${current.waiting} · ${tr('Ready', '可执行')} ${current.ready} · ${tr('Deferred', '暂缓')} ${current.deferred} · ${t('index.failed')} ${current.failed} · ${current.running??t('index.idle')}${next}`);
  };
  render();
  const stop=lifecycle.observe(render), Observer=container.ownerDocument.defaultView?.MutationObserver;
  const observer=Observer?new Observer(()=>{if(!status.isConnected){stop();observer?.disconnect();}}):undefined;
  observer?.observe(container.ownerDocument.body,{childList:true,subtree:true});
  plugin.register(()=>{stop();observer?.disconnect();});
  const report=(title:string,text:string)=>{
    const modal=new Modal(plugin.app);modal.setTitle(title);
    modal.contentEl.createEl('pre',{text,cls:'llm-hub-index-report'});
    modal.open();
  };
  let checked:Awaited<ReturnType<typeof lifecycle.check>>|undefined;
  const run=(work:()=>Promise<unknown>)=>{void work().then(result=>{render();if(result!==false)new Notice(t('index.finished'));}).catch(error=>{render();new Notice(error instanceof Error?error.message:String(error));});};
  new Setting(container).setName(t('index.check')).addButton(button=>button.setButtonText(t('index.check')).onClick(()=>run(async()=>{
    checked=await plugin.tasks.run(t('index.check'),control=>lifecycle.check(name,control),{descriptor:{kind:'custom',setting:name}});
    const labels={missing:'index.missing',unindexed:'index.unindexed',changed:'index.changed',legacy:'index.legacy',corrupt:'index.corrupt',needsReview:'index.needsReview'} as const;
    report(t('index.report'),Object.entries(checked).map(([key,paths])=>t(labels[key as keyof typeof labels])+' · '+paths.length+'\n'+paths.join('\n')).join('\n\n'));
  }))).addButton(button=>button.setButtonText(t('index.repair')).onClick(()=>{
    if(!checked){new Notice(t('index.check'));return;}
    const snapshot=checked, selected=new Set([...snapshot.missing,...snapshot.unindexed,...snapshot.changed,...snapshot.legacy,...snapshot.corrupt]),modal=new Modal(plugin.app);
    modal.setTitle(t('index.repair'));
    const list=modal.contentEl.createDiv({cls:'llm-hub-index-report'});
    for(const path of selected)new Setting(list).setName(path).addToggle(toggle=>toggle.setValue(true).onChange(value=>{if(value)selected.add(path);else selected.delete(path);}));
    new Setting(modal.contentEl).addButton(button=>button.setButtonText(t('index.repair')).onClick(()=>{
      modal.close();run(()=>lifecycle.repair(name,[...selected],snapshot.corrupt));
    }));modal.open();
  }));
  new Setting(container).setName(t('index.rebuild')).addButton(button=>button.setButtonText(t('index.rebuild')).onClick(()=>run(async()=>{
    if(!await new ConfirmModal(plugin.app,t('index.rebuildConfirm')+' · '+name,t('index.rebuild'),t('common.cancel')).openAndWait())return false;
    await plugin.rebuildRagIndex(name);
  }))).addButton(button=>button.setButtonText(t('index.cancel')).onClick(()=>run(async()=>{
    for(const task of plugin.tasks.list())if(task.snapshot.descriptor?.setting===name)task.cancel();
    await lifecycle.cancel(name);
  })));
  new Setting(container).setName(t('index.failed')).addButton(button=>button.setButtonText(t('index.retry')).onClick(()=>run(async()=>{await lifecycle.retry(name);await lifecycle.flush();})))
    .addButton(button=>button.setButtonText(t('index.report')).onClick(()=>report(t('index.failed'),lifecycle.status(name).failures.map(failure=>failure.path+'\n'+failure.reason).join('\n\n')||t('index.idle'))));
  new Setting(container).setName(t('index.compact')).setDesc(t('index.compactDescription')).addButton(button=>button.setButtonText(t('index.compact')).onClick(()=>run(()=>plugin.compactRagIndex(name))));
}
