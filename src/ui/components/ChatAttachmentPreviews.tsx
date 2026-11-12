import { Modal, TFile, type App } from 'obsidian';
import { Attachments } from 'obsidian-llm-hub-common';
import X from 'lucide-react/dist/esm/icons/x';
import type { Attachment } from 'src/types';
import { t } from 'src/i18n';

interface Props { attachments: readonly Attachment[]; app: App; onRemove?: (index: number) => void }

function imageUrl(attachment: Attachment, app: App): string | null {
  if (attachment.type !== 'image' || !attachment.mimeType.startsWith('image/')) return null;
  if (attachment.data) return `data:${attachment.mimeType};base64,${attachment.data}`;
  if (attachment.sourcePath) {
    const file = app.vault.getAbstractFileByPath(attachment.sourcePath);
    if (file instanceof TFile) return app.vault.getResourcePath(file);
  }
  return null;
}

class ImagePreviewModal extends Modal {
  constructor(app: App, private url: string, private name: string) { super(app); }
  onOpen(): void {
    this.setTitle(this.name);
    this.modalEl.addClass('llm-hub-image-preview-modal');
    this.contentEl.createEl('img', { attr: { src: this.url, alt: this.name } });
  }
  onClose(): void { this.contentEl.empty(); }
}

export function ChatAttachmentPreviews({ attachments, app, onRemove }: Props) {
  if (!attachments.length) return null;
  return <div className="llm-hub-attachment-previews">{attachments.map((attachment, index) => {
    const url = imageUrl(attachment, app);
    return url ? <div className={`llm-hub-image-tile${onRemove ? ' llm-hub-pending-attachment' : ''}`} key={index}>
      <button type="button" className="llm-hub-image-open" title={attachment.name} aria-label={`${t('chat.imagePreview')} · ${attachment.name}`}
        onClick={() => new ImagePreviewModal(app, url, attachment.name).open()}><img className={onRemove ? 'llm-hub-safe-guard-pending-thumb' : undefined} src={url} alt={attachment.name}/></button>
      {onRemove && <span className="llm-hub-image-filename">{attachment.name}</span>}
      {onRemove && <button type="button" className="llm-hub-image-remove" aria-label={`${t('input.removeAttachment')} · ${attachment.name}`}
        onClick={() => onRemove(index)}><X size={12}/></button>}
    </div> : <Attachments key={index} classPrefix="llm-hub" attachments={[attachment]} pending={!!onRemove}
      onRemove={onRemove ? () => onRemove(index) : undefined} removeLabel={t('input.removeAttachment')}/>;
  })}</div>;
}
