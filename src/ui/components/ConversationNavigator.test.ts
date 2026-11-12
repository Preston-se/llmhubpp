import { describe, expect, it } from 'vitest';
import { getConversationTurns } from './ConversationNavigator';
import type { Message } from 'src/types';

describe('conversation turns', () => {
  it('groups tools and assistant continuations under their user question', () => {
    const messages: Message[] = ['assistant', 'user', 'tool', 'assistant', 'assistant', 'user'].map((role, index) => ({ role, content: String(index), timestamp: index })) as Message[];
    expect(getConversationTurns(messages)).toEqual([{ messageIndex: 1, label: '1' }, { messageIndex: 5, label: '5' }]);
  });
  it('labels an image-only question and preserves the seventh round', () => {
    const messages: Message[] = Array.from({ length: 7 }, (_, i) => ({ role: 'user', content: '', timestamp: i,
      attachments: [{ name: `Image ${i}.png`, type: 'image', mimeType: 'image/png', data: '' }] }));
    expect(getConversationTurns(messages)).toHaveLength(7);
    expect(getConversationTurns(messages)[6]).toEqual({ messageIndex: 6, label: 'Image 6.png' });
  });
});
