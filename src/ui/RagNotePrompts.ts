import { MarkdownView, Modal, Notice, Setting, type Plugin, type TFile, type WorkspaceLeaf } from 'obsidian';
import type { RagLifecycle } from 'src/core/ragLifecycle';
import { settingsText as tr } from './settings/settingsText';

type Choice = 'update' | 'wait' | 'defer' | 'cancel';

class IndexUpdateModal extends Modal {
  private choice: Choice = 'cancel';

  constructor(app: Plugin['app'], private readonly paths: readonly string[],
    private readonly mode: 'tab' | 'reopen' | 'exit' | 'failed', private readonly allowWait: boolean,
    private readonly hasOtherTasks: boolean, private readonly resolve: (choice: Choice) => void) { super(app); }

  onOpen(): void {
    const exiting = this.mode === 'exit' || this.mode === 'failed';
    this.setTitle(this.mode === 'failed' ? tr('Some indexes could not be updated', '部分索引更新失败') : tr('Notes awaiting indexing', '笔记等待索引'));
    this.contentEl.createEl('p', { text: tr('Your notes are saved separately. The existing index stays available until you update it.', '笔记照常保存。更新前可以继续使用原索引。') });
    const list = this.contentEl.createEl('ul');
    for (const path of this.paths.slice(0, 6)) list.createEl('li', { text: path });
    if (this.paths.length > 6) list.createEl('li', { text: tr(`${this.paths.length - 6} more`, `另有 ${this.paths.length - 6} 篇`) });
    if (this.hasOtherTasks) this.contentEl.createEl('p', { text: tr('Other unfinished tasks will be saved and paused on exit.', '退出时会保存并暂停其他未完成的任务。') });
    const actions = new Setting(this.contentEl);
    const choose = (choice: Choice) => { this.choice = choice; this.close(); };
    if (exiting) actions.addButton(button => button.setButtonText(tr('Stay in Obsidian', '留在 Obsidian')).onClick(() => choose('cancel')));
    if (this.mode === 'tab' && this.allowWait) actions.addButton(button => button.setButtonText(tr('Continue waiting', '继续等待')).onClick(() => choose('wait')));
    actions.addButton(button => button.setButtonText(exiting ? tr('Exit without updating', '退出并暂不更新') : tr('Keep existing index', '暂不更新')).onClick(() => choose('defer')));
    if (this.mode !== 'failed') actions.addButton(button => button.setButtonText(exiting ? tr('Update and exit', '更新后退出') : tr('Update now', '现在更新')).setCta().onClick(() => choose('update')));
  }

  onClose(): void { this.resolve(this.choice); this.contentEl.empty(); }
}

export class RagNotePrompts {
  private open = new Map<WorkspaceLeaf, TFile>();
  private closed = new Set<string>();
  private timer?: number;
  private tail: Promise<void> = Promise.resolve();
  private modal?: IndexUpdateModal;
  private exiting = false;
  private disposed = false;

  constructor(private readonly plugin: Plugin, private readonly lifecycle: RagLifecycle,
    private readonly allowWait: () => boolean, private readonly hasOtherTasks: () => boolean) {
    const { workspace, vault } = plugin.app;
    workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.open = this.markdownLeaves();
      this.showReminder(workspace.getActiveFile()?.path);
    });
    plugin.registerEvent(workspace.on('layout-change', () => this.layoutChanged()));
    plugin.registerEvent(workspace.on('editor-change', (editor, info) => {
      if (info.file) lifecycle.noteEditorChanged(info.file.path, editor.getValue());
    }));
    plugin.registerEvent(workspace.on('file-open', file => this.showReminder(file?.path)));
    plugin.registerEvent(vault.on('modify', file => { if (this.closed.has(file.path)) this.scheduleClosed(); }));
    plugin.register(() => {
      this.disposed = true;
      if (this.timer !== undefined) window.clearTimeout(this.timer);
      this.modal?.close();
    });
  }

  private markdownLeaves(): Map<WorkspaceLeaf, TFile> {
    const files = new Map<WorkspaceLeaf, TFile>();
    this.plugin.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView && leaf.view.file) files.set(leaf, leaf.view.file);
    });
    return files;
  }

  private layoutChanged(): void {
    const next = this.markdownLeaves();
    const remaining = new Set([...next.values()].map(file => file.path));
    for (const [leaf, file] of this.open) {
      if (remaining.has(file.path)) continue;
      if (!next.has(leaf)) this.closed.add(file.path);
      else this.lifecycle.releaseEditorChange(file.path);
    }
    this.open = next;
    for (const path of remaining) this.closed.delete(path);
    if (this.closed.size) this.scheduleClosed();
  }

  private scheduleClosed(): void {
    if (this.timer !== undefined || this.disposed || this.exiting) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.enqueue(async () => {
        await this.lifecycle.settleNoteChanges();
        const unsaved = new Set(this.lifecycle.unsavedNotePaths());
        const pending = new Set(this.lifecycle.pendingNotePaths());
        const paths = [...this.closed].filter(path => !unsaved.has(path));
        for (const path of paths) this.closed.delete(path);
        const selected = paths.filter(path => pending.has(path));
        if (selected.length) await this.chooseForClosedNotes(selected);
      });
    }, 0);
  }

  private enqueue(run: () => Promise<void>): void {
    this.tail = this.tail.then(async () => { if (!this.disposed && !this.exiting) await run(); })
      .catch(() => { if (!this.disposed) new Notice(tr('Could not save the index choice.', '无法保存索引选择。')); });
  }

  private showReminder(path?: string): void {
    if (!path) return;
    this.enqueue(async () => {
      if (!await this.lifecycle.getOpenReminder(path) || this.exiting || this.disposed) return;
      if (await this.ask([path], 'reopen') === 'update') await this.update([path]);
    });
  }

  private async chooseForClosedNotes(paths: string[]): Promise<void> {
    if (this.exiting || this.disposed) return;
    this.lifecycle.freezeNoteUpdates(paths);
    let choice: Choice;
    try {
      choice = await this.ask(paths, 'tab');
      if (this.exiting || this.disposed) return;
      if (choice === 'wait') await this.lifecycle.chooseNoteUpdates(paths, 'wait');
      if (choice === 'defer' || choice === 'cancel' && !this.allowWait()) await this.lifecycle.chooseNoteUpdates(paths, 'remind');
    } finally { this.lifecycle.unfreezeNoteUpdates(paths); }
    if (choice === 'update') await this.update(paths);
  }

  private async ask(paths: readonly string[], mode: 'tab' | 'reopen' | 'exit' | 'failed'): Promise<Choice> {
    if (this.disposed) return 'cancel';
    return new Promise(resolve => {
      const modal = new IndexUpdateModal(this.plugin.app, paths, mode, this.allowWait(), mode === 'exit' && this.hasOtherTasks(), choice => {
        if (this.modal === modal) this.modal = undefined;
        resolve(choice);
      });
      this.modal = modal;
      modal.open();
    });
  }

  private async update(paths: readonly string[]): Promise<string[]> {
    const report = await this.lifecycle.updatePendingNotes(paths);
    const failed = [...new Set(report.failures.map(failure => failure.path))];
    if (failed.length) new Notice(tr('Some indexes could not be updated. See index settings.', '部分索引更新失败，请查看索引设置。'));
    return failed;
  }

  hasWork(): boolean {
    return this.lifecycle.pendingNotePaths().length > 0 || this.lifecycle.unsavedNotePaths().length > 0;
  }

  async beforeExit(): Promise<boolean | undefined> {
    this.exiting = true;
    this.modal?.close();
    await this.tail;
    const dirty = new Set(this.lifecycle.unsavedNotePaths());
    const pathsOnEntry = [...new Set([...dirty, ...this.lifecycle.pendingNotePaths()])];
    this.lifecycle.freezeNoteUpdates(pathsOnEntry);
    let paths: string[] = [];
    try {
      const saves: Promise<void>[] = [];
      this.plugin.app.workspace.iterateAllLeaves(leaf => {
        if (leaf.view instanceof MarkdownView && leaf.view.file && dirty.delete(leaf.view.file.path)) saves.push(leaf.view.save());
      });
      await Promise.all(saves);
      await this.lifecycle.settleNoteChanges();
      paths = this.lifecycle.pendingNotePaths();
      if (!paths.length) return undefined;
      const choice = await this.ask(paths, 'exit');
      if (choice === 'defer') {
        await this.lifecycle.chooseNoteUpdates(paths, 'remind');
        return true;
      }
      if (choice !== 'update') return false;
    } finally {
      this.lifecycle.unfreezeNoteUpdates(pathsOnEntry);
      this.exiting = false;
    }
    this.exiting = true;
    try {
      const failed = await this.update(paths);
      if (!failed.length) return true;
      if (await this.ask(failed, 'failed') !== 'defer') return false;
      await this.lifecycle.chooseNoteUpdates(failed, 'remind');
      return true;
    } finally { this.exiting = false; }
  }
}
