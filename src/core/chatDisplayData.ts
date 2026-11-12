import type { Message } from 'src/types';
import { readGroundedEvidence } from './groundedAnswer';

const DISPLAY_ID = '__llmhubpp_chat_display_v1__';
type DisplayData = Pick<Message, 'attachments' | 'ragCitations' | 'ragContexts'> & { version: 1 };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';

function valid(data: unknown): data is DisplayData {
  if (!record(data) || data.version !== 1) return false;
  if (data.attachments !== undefined && (!Array.isArray(data.attachments) || data.attachments.some(item =>
    !record(item) || typeof item.name !== 'string' || typeof item.mimeType !== 'string' || typeof item.data !== 'string'
    || !['image', 'pdf', 'text', 'audio', 'video'].includes(String(item.type))
    || !optionalString(item.sourcePath) || !optionalString(item.pageLabel)))) return false;
  if (data.ragCitations !== undefined && (!Array.isArray(data.ragCitations) || data.ragCitations.some(item =>
    !record(item) || typeof item.filePath !== 'string' || typeof item.startOffset !== 'number' || !Number.isFinite(item.startOffset)
    || !optionalString(item.heading) || !optionalString(item.snippet) || !optionalString(item.pageLabel)))) return false;
  if (data.ragContexts !== undefined && (!Array.isArray(data.ragContexts) || data.ragContexts.some(item =>
    !record(item) || typeof item.source !== 'string' || typeof item.text !== 'string'))) return false;
  return true;
}

/** The shared writer retains tool results but drops attachments and old snippet fields. */
export function persistChatDisplayData(message: Message): Message {
  const legacy = !readGroundedEvidence(message);
  const data: DisplayData = { version: 1,
    attachments: message.attachments?.length ? message.attachments : undefined,
    ragCitations: legacy && message.ragCitations?.length ? message.ragCitations : undefined,
    ragContexts: legacy && message.ragContexts?.length ? message.ragContexts : undefined,
  };
  if (!data.attachments && !data.ragCitations && !data.ragContexts) return message;
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return { ...message, toolResults: [...(message.toolResults ?? []).filter(item => item.toolCallId !== DISPLAY_ID),
    { toolCallId: DISPLAY_ID, result: { kind: 'llmhubpp-chat-display', data: btoa(binary) } }] };
}

/** Restore before displaying or continuing a chat; storage-only metadata never enters model history. */
export function restoreChatDisplayData(message: Message): Message {
  for (const item of message.toolResults ?? []) {
    if (item.toolCallId !== DISPLAY_ID || !record(item.result) || item.result.kind !== 'llmhubpp-chat-display' || typeof item.result.data !== 'string') continue;
    try {
      const binary = atob(item.result.data);
      const data: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
      if (!valid(data)) continue;
      const remaining = message.toolResults?.filter(result => result.toolCallId !== DISPLAY_ID);
      return { ...message, attachments: message.attachments ?? data.attachments,
        ragCitations: message.ragCitations ?? data.ragCitations, ragContexts: message.ragContexts ?? data.ragContexts,
        toolResults: remaining?.length ? remaining : undefined };
    } catch { /* Preserve invalid/future metadata without applying it. */ }
  }
  return message;
}

