import { useEffect, useState, type RefObject } from 'react';
import type { Message } from 'src/types';
import { t } from 'src/i18n';

export function getConversationTurns(messages: readonly Message[]): { messageIndex: number; label: string }[] {
  return messages.flatMap((message, messageIndex) => message.role === 'user' ? [{ messageIndex,
    label: (message.content.trim() || message.attachments?.map(item => item.name).join(', ') || t('chat.attachmentQuestion')).replace(/\s+/g, ' ').slice(0, 180) }] : []);
}

interface Props {
  messages: readonly Message[];
  containerRef: RefObject<HTMLDivElement>;
  conversationKey: string;
  onNavigate: () => void;
}

export function ConversationNavigator({ messages, containerRef, conversationKey, onNavigate }: Props) {
  const turns = getConversationTurns(messages);
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || turns.length <= 6) return;
    const track = () => {
      const top = container.getBoundingClientRect().top + 30;
      const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-turn]'));
      const active = nodes.filter(node => node.getBoundingClientRect().top <= top).pop();
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 3;
      setCurrent(atBottom ? turns[turns.length - 1].messageIndex : Number(active?.dataset.chatTurn ?? turns[0].messageIndex));
    };
    track();
    container.addEventListener('scroll', track, { passive: true });
    return () => container.removeEventListener('scroll', track);
  }, [containerRef, messages, conversationKey]);
  if (turns.length <= 6) return null;
  return <nav className="llm-hub-turn-navigation" aria-label={t('chat.turnNavigation')}>{turns.map(turn => <button
    key={turn.messageIndex} type="button" aria-current={current === turn.messageIndex ? 'location' : undefined} title={turn.label}
    onClick={() => {
      onNavigate();
      containerRef.current?.querySelector<HTMLElement>(`[data-chat-turn="${turn.messageIndex}"]`)?.scrollIntoView({ block: 'start' });
      setCurrent(turn.messageIndex);
    }}><span className="llm-hub-turn-line"/><span className="llm-hub-turn-label">{turn.label}</span></button>)}</nav>;
}
