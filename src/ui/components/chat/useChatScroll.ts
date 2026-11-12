import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Message } from 'src/types';

export const CHAT_SCROLL_LATEST_EVENT = "llmhub-scroll-latest";

interface Options {
  containerRef: RefObject<HTMLDivElement>;
  conversationKey: string;
  messages: readonly Message[];
  streamingContent: string;
  streamingThinking: string;
}

export function useChatScroll({ containerRef, conversationKey, messages, streamingContent, streamingThinking }: Options) {
  const follow = useRef(true), frame = useRef(0);
  const [following, setFollowing] = useState(true);
  const scrollToLatest = () => {
    follow.current = true;
    setFollowing(true);
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  };
  const holdPosition = () => { follow.current = false; setFollowing(false); };
  const update = () => {
    const container = containerRef.current, win = container?.ownerDocument.defaultView;
    if (!container || !win || !follow.current) return;
    win.cancelAnimationFrame(frame.current);
    frame.current = win.requestAnimationFrame(() => { if (follow.current) container.scrollTop = container.scrollHeight; });
  };
  useEffect(() => {
    const container = containerRef.current, win = container?.ownerDocument.defaultView;
    if (!container || !win) return;
    follow.current = true;
    setFollowing(true);
    const onScroll = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 48;
      follow.current = atBottom;
      setFollowing(atBottom);
    };
    container.addEventListener('scroll', onScroll);
    container.addEventListener(CHAT_SCROLL_LATEST_EVENT, scrollToLatest);
    const resize = win.ResizeObserver ? new win.ResizeObserver(update) : null;
    const observe = () => {
      resize?.disconnect();
      resize?.observe(container);
      for (const child of Array.from(container.children)) resize?.observe(child);
      update();
    };
    const mutation = win.MutationObserver ? new win.MutationObserver(observe) : null;
    mutation?.observe(container, { childList: true });
    observe();
    return () => {
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener(CHAT_SCROLL_LATEST_EVENT, scrollToLatest);
      resize?.disconnect();
      mutation?.disconnect();
      win.cancelAnimationFrame(frame.current);
    };
  }, [containerRef, conversationKey]);
  useEffect(update, [messages, streamingContent, streamingThinking, conversationKey]);
  return { following, scrollToLatest, holdPosition };
}
