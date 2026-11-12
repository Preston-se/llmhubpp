import { expect, it } from 'vitest';
import { messagesToMarkdown, parseMarkdownToMessages } from 'obsidian-llm-hub-common/chat';
import { persistChatDisplayData, restoreChatDisplayData } from './chatDisplayData';
import { getAnswerCitations } from './answerCitations';
import type { Message } from 'src/types';

const message: Message = { role: 'user', content: '图片问题', timestamp: 1,
  attachments: [{ name: '截图.png', type: 'image', mimeType: 'image/png', data: 'cGljdHVyZQ==' },
    { name: '讲义.pdf', type: 'pdf', mimeType: 'application/pdf', data: 'cGRm', sourcePath: 'Study/讲义.pdf', pageLabel: 'pages 2-3' }],
  ragCitations: [{ filePath: 'Study/book.md', heading: '章节', startOffset: 41, snippet: '历史片段' }],
  ragContexts: [{ source: 'Study/book.md', text: '旧版上下文' }],
  toolResults: [{ toolCallId: 'real-tool', result: { success: true } }],
};
async function roundTrip(input: Message) {
  const markdown = await messagesToMarkdown([persistChatDisplayData(input)], '历史测试', 1);
  return restoreChatDisplayData(parseMarkdownToMessages(markdown).messages[0]);
}
it('preserves image bytes and legacy snippet positions through the actual shared history serializer', async () => {
  const restored = await roundTrip(message);
  expect(restored.attachments).toEqual(message.attachments);
  expect(restored.ragCitations).toEqual(message.ragCitations);
  expect(restored.ragContexts).toEqual(message.ragContexts);
  expect(restored.toolResults).toEqual(message.toolResults);
  expect(getAnswerCitations(restored).status).toBe('legacy-unmapped');
  expect(message.toolResults).toHaveLength(1);
});
it('keeps metadata stable when a restored conversation is saved again', async () => {
  const restored = await roundTrip(await roundTrip(message));
  expect(restored.attachments).toEqual(message.attachments);
  expect(restored.toolResults).toEqual(message.toolResults);
});
it('ignores malformed or future display metadata without changing the message', () => {
  const saved = persistChatDisplayData(message);
  for (const data of ['not-base64', btoa('{"version":2}'), btoa('{"version":1,"attachments":[null]}')]) {
    const invalid = { ...saved, toolResults: [{ toolCallId: '__llmhubpp_chat_display_v1__', result: { kind: 'llmhubpp-chat-display', data } }] };
    expect(restoreChatDisplayData(invalid)).toBe(invalid);
  }
});
