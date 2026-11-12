import { FuzzySuggestModal, type App } from 'obsidian';
import { t } from 'src/i18n';

export class RagIndexTargetModal extends FuzzySuggestModal<string> {
  constructor(app: App, private readonly names: string[], private readonly choose: (name: string) => void) {
    super(app);
    this.setPlaceholder(t('index.choose'));
  }
  getItems(): string[] { return this.names; }
  getItemText(name: string): string { return name; }
  onChooseItem(name: string): void { this.choose(name); }
}
