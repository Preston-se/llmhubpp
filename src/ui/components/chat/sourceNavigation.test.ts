import { describe, expect, it, vi } from 'vitest';
import { findExcerptRange, openCitationSource } from './sourceNavigation';
import type { AnswerSource } from 'src/core/answerCitations';

const status = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
vi.mock('src/core/ragSourceStatus', () => ({ getRagSourceStatus: status }));
vi.mock('src/core/localRagStore', () => ({ getLocalRagStore: () => ({ resolveDocument: resolve }) }));
const source: AnswerSource = { id: 1, filePath: 'Study/book.md', text: 'second paragraph' };

describe('source navigation', () => {
  it('resolves moved document identities and refuses a replacement at the old path', async () => {
    const openLinkText=vi.fn(),app={vault:{adapter:{}},workspace:{openLinkText,getActiveViewOfType:()=>null,getLeavesOfType:()=>[]}} as never;
    status.mockResolvedValue('available');resolve.mockResolvedValue('Study/moved.md');
    const cited={...source,documentId:'stable',indexSetting:'S'};
    expect(await openCitationSource(app,cited)).toBe('opened');
    expect(openLinkText).toHaveBeenCalledWith('Study/moved.md','',false);
    resolve.mockResolvedValue(null);openLinkText.mockClear();
    expect(await openCitationSource(app,cited)).toBe('missing');expect(openLinkText).not.toHaveBeenCalled();
  });
  it('matches excerpts despite line ending and whitespace differences', () => {
    const value = 'Intro\r\nsecond   paragraph\r\nEnd';
    const range = findExcerptRange(value, source)!;
    expect(value.slice(range.from, range.to)).toBe('second   paragraph');
  });
  it('validates stored offsets and rejects ambiguous duplicate text', () => {
    const content = 'second paragraph\nother\nsecond paragraph';
    expect(findExcerptRange(content, source)).toBeNull();
    expect(findExcerptRange(content, { ...source, documentOffset: 23 })).toEqual({ from: 23, to: 39 });
    expect(findExcerptRange('changed file', source)).toBeNull();
    expect(findExcerptRange('prefix second paragraph', { ...source, documentOffset: 0 })).toEqual({ from: 7, to: 23 });
  });
  it('opens a PDF at its recorded page and refuses missing files', async () => {
    const openLinkText = vi.fn();
    const app = { vault: { adapter: {} }, workspace: { openLinkText } } as never;
    status.mockResolvedValue('available');
    expect(await openCitationSource(app, { ...source, filePath: 'Study/book.pdf', pageLabel: 'pages 3-4 of 9' })).toBe('located');
    expect(openLinkText).toHaveBeenCalledWith('Study/book.pdf#page=3', '', false);
    status.mockResolvedValue('missing');
    expect(await openCitationSource(app, source)).toBe('missing');
    expect(openLinkText).toHaveBeenCalledTimes(1);
  });
});
