
import { Modal, Setting, type App } from 'obsidian';
import { settingsText as tr } from 'src/ui/settings/settingsText';
export class RequestPayloadModal extends Modal {
  private resolve?:(value:boolean)=>void;
  constructor(app:App,private readonly origin:string,private readonly payload:string){super(app);}
  openAndWait():Promise<boolean>{return new Promise(resolve=>{this.resolve=resolve;this.open();});}
  onOpen():void {
    this.setTitle(tr('Review outgoing original text','检查即将发送的原文'));
    this.contentEl.createEl('p',{text:tr('Destination: ','目标服务：')+this.origin});
    this.contentEl.createEl('pre',{text:this.payload,cls:'llm-hub-index-report'});
    new Setting(this.contentEl).addButton(button=>button.setButtonText(tr('Send this request','仅发送这一次')).onClick(()=>{this.resolve?.(true);this.resolve=undefined;this.close();}))
      .addButton(button=>button.setButtonText(tr('Cancel','取消')).onClick(()=>this.close()));
  }
  onClose():void{this.resolve?.(false);this.resolve=undefined;this.contentEl.empty();}
}
