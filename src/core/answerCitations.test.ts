import { describe, expect, it } from 'vitest';
import { attachGroundedEvidence, type GroundedEvidence } from './groundedAnswer';
import { getAnswerCitations, getRenderedCitationTokens, parseCitationTokens } from './answerCitations';
import type { Message } from 'src/types';

const evidence: GroundedEvidence = { version: 1, settingName: 'Study', query: 'question', omittedCount: 0, truncated: false,
  sources: Array.from({ length: 6 }, (_, index) => ({ id: index + 1, filePath: index < 2 ? 'Study/book.md' : `Other/${index}.md`,
    chunkIndex: index, text: `Excerpt ${index}`, sourceStatus: 'available', truncated: false })) };
const message = (content: string) => attachGroundedEvidence({ role: 'assistant', timestamp: 1, content }, evidence);

describe('answer citations', () => {
  it('shows two cited excerpts from six candidates and preserves their original ids', () => {
    const original = message('First [2], then [1], again [2].');
    expect(getAnswerCitations(original).sources.map(s => s.id)).toEqual([2, 1]);
    expect(original.ragContexts).toHaveLength(6);
  });
  it('keeps distinct chunks from the same document', () => {
    expect(getAnswerCitations(message('Answer [1][2]')).sources.map(s => s.chunkIndex)).toEqual([0, 1]);
  });
  it('ignores code, links, formulas, escaped markers and reference definitions', () => {
    const content = 'Text [1] `code [2]`\n```md\n[3]\n```\n[4](https://example.test) $[5]$ \\[6]\n[2]: reference\nMore [2]';
    const tokens = parseCitationTokens(content);
    expect(tokens.map(t => t.id)).toEqual([1]);
    expect(tokens.map(t => content.slice(t.start, t.end))).toEqual(['[1]']);
  });
  it('reports unknown and absent citations without claiming all retrieved sources were used', () => {
    expect(getAnswerCitations(message('Unknown [99]'))).toMatchObject({ sources: [], unknownIds: [99], status: 'uncited' });
    expect(getAnswerCitations(message('No markers'))).toMatchObject({ sources: [], status: 'uncited' });
  });
  it('does not reuse a different turn or infer a mapping from legacy paths', () => {
    const legacy: Message = { role: 'assistant', content: 'Old [1]', timestamp: 2, ragUsed: true, ragSources: ['Other/book.md'] };
    expect(getAnswerCitations(legacy)).toMatchObject({ sources: [], status: 'legacy-unmapped' });
    expect(getAnswerCitations({ role: 'assistant', content: '[1]', timestamp: 3 }).sources).toEqual([]);
  });
  it('excludes indented code, wikilinks and shortcut reference links', () => {
    expect(parseCitationTokens('    let a = [1];\n\nAnswer [2]').map(t => t.id)).toEqual([2]);
    expect(parseCitationTokens('[[1]] and [2]').map(t => t.id)).toEqual([2]);
    expect(parseCitationTokens('Link [1]\n\n[1]: https://example.org\nAnswer [2]').map(t => t.id)).toEqual([2]);
  });
  it('decorates only the actual citation after Markdown unescapes a literal with the same id', () => {
    const tokens = getRenderedCitationTokens('Literal \\[1] and valid **[1]**', ['Literal [1] and valid ', '[1]']);
    expect(tokens.map(items => items.map(t => t.id))).toEqual([[], [1]]);
  });
});
