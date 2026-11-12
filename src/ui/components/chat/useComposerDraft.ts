import { useRef, useState } from "react";
import type { Attachment } from "src/types";

interface Draft {
  input: string;
  attachments: Attachment[];
  reading: number;
}

const EMPTY_DRAFT: Draft = { input: "", attachments: [], reading: 0 };

/** Retain unsent content for each conversation in this view. */
export function useComposerDraft(conversationKey: string) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const reads = useRef(new Map<string, number>());
  const draft = drafts[conversationKey] ?? EMPTY_DRAFT;

  const update = (change: (draft: Draft) => Draft, owner = conversationKey) => {
    setDrafts(previous => ({ ...previous, [owner]: change(previous[owner] ?? EMPTY_DRAFT) }));
  };
  const addAttachments = (attachments: Attachment[], owner = conversationKey) => {
    update(previous => ({ ...previous, attachments: [...previous.attachments, ...attachments] }), owner);
  };
  const setReading = (owner: string, count: number) => {
    if (count > 0) reads.current.set(owner, count);
    else reads.current.delete(owner);
    update(previous => ({ ...previous, reading: count }), owner);
  };
  const readAttachments = async (
    files: readonly File[],
    read: (file: File) => Promise<Attachment | null>,
    owner = conversationKey,
  ) => {
    setReading(owner, (reads.current.get(owner) ?? 0) + 1);
    try {
      for (const file of files) {
        const attachment = await read(file);
        if (attachment) addAttachments([attachment], owner);
      }
    } finally {
      setReading(owner, (reads.current.get(owner) ?? 1) - 1);
    }
  };

  return {
    input: draft.input,
    pendingAttachments: draft.attachments,
    processingAttachments: draft.reading > 0,
    hasActiveAttachmentRead: () => (reads.current.get(conversationKey) ?? 0) > 0,
    setInput: (input: string) => update(previous => ({ ...previous, input })),
    addAttachments,
    removeAttachment: (index: number) =>
      update(previous => ({ ...previous, attachments: previous.attachments.filter((_, i) => i !== index) })),
    readAttachments,
    clearAcceptedDraft: (submittedInput: string, submittedAttachments: readonly Attachment[]) => {
      // The accepted turn owns its captured text and files. Keep any later edits or attachments.
      update(previous => ({
        input: previous.input === submittedInput ? "" : previous.input,
        attachments: previous.attachments.filter(attachment => !submittedAttachments.includes(attachment)),
        reading: previous.reading,
      }));
    },
  };
}

/** Keep the draft key stable when a new chat receives a saved history ID. */
export function useComposerConversationKey(currentChatId: string | null) {
  const [key, setKey] = useState("new:0");
  const newChatSequence = useRef(0);
  const historyKeys = useRef(new Map<string, string>());
  const rememberChat = (id: string) => { historyKeys.current.set(id, key); };
  if (currentChatId) rememberChat(currentChatId);
  return {
    key,
    startNewDraft: () => setKey(`new:${++newChatSequence.current}`),
    selectHistory: (id: string) => setKey(historyKeys.current.get(id) ?? `chat:${id}`),
    rememberChat,
  };
}
