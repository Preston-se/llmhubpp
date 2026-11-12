import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatAttachmentPreviews } from './ChatAttachmentPreviews';
import type { Attachment } from 'src/types';

describe('chat attachment previews', () => {
  const attachments: Attachment[] = [
    { name: 'first.png', type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    { name: 'book.pdf', type: 'pdf', mimeType: 'application/pdf', data: 'cGRm' },
    { name: 'second.png', type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
  ];
  it('restores ordered thumbnails from saved attachments and preserves non-image attachments', () => {
    const html = renderToStaticMarkup(createElement(ChatAttachmentPreviews, { attachments, app: {} as never }));
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('data:image/png;base64,aGVsbG8=');
    expect(html.indexOf('first.png')).toBeLessThan(html.indexOf('book.pdf'));
    expect(html.indexOf('book.pdf')).toBeLessThan(html.indexOf('second.png'));
  });
  it('preserves the Safe Guard pending marker, filename and existing thumbnail contract', () => {
    const html = renderToStaticMarkup(createElement(ChatAttachmentPreviews, { attachments: [attachments[0]], app: {} as never, onRemove() {} }));
    expect(html).toContain('llm-hub-pending-attachment');
    expect(html).toContain('llm-hub-safe-guard-pending-thumb');
    expect(html).toContain('>first.png</span>');
  });
});
