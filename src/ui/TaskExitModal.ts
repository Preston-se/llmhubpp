import { App, Modal, Setting } from 'obsidian';
export class TaskExitModal extends Modal {
    private answer = false;
    constructor(app: App, private resolve: (save: boolean) => void) { super(app); }
    onOpen(): void {
        this.titleEl.setText('还有未完成的任务');
        this.contentEl.createDiv({ text: '保存并退出会保留已完成分段和可恢复批次。下次打开后任务保持暂停，由你点击继续。' });
        new Setting(this.contentEl).addButton(b => b.setButtonText('继续处理').onClick(() => this.close())).addButton(b => b.setButtonText('保存并退出').setCta().onClick(() => { this.answer = true; this.close(); }));
    }
    onClose(): void { this.resolve(this.answer); }
}
