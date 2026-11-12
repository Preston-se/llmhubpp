import { useEffect, useRef, type RefObject } from 'react';
import type { Message } from 'src/types';
import { getAnswerCitations, getRenderedCitationTokens, type AnswerSource } from 'src/core/answerCitations';

interface Options {
  containerRef: RefObject<HTMLDivElement>;
  message: Message;
  onSelect: (anchor: HTMLElement, source: AnswerSource) => void;
  onOpen: (source: AnswerSource) => Promise<void>;
}

/** Decorate the shared renderer's Markdown without replacing its link/tool handlers. */
export function useCitationMarkup({ containerRef, message, onSelect, onOpen }: Options): void {
  const callbacks = useRef({ onSelect, onOpen });
  callbacks.current = { onSelect, onOpen };
  useEffect(() => {
    const root = containerRef.current;
    const Observer = root?.ownerDocument.defaultView?.MutationObserver;
    if (!root || !Observer) return;
    const sources = getAnswerCitations(message).sources;
    const byId = new Map(sources.map(source => [source.id, source]));
    if (!sources.length) return;
    const doc = root.ownerDocument;
    const decorate = () => {
      observer.disconnect();
      const content = root.querySelector('.llm-hub-message-content');
      if (content) {
        const walker = doc.createTreeWalker(content, 5);
        const nodes: Array<Text | HTMLElement> = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (node.nodeType === 1 && (node as HTMLElement).matches('[data-llmhub-citation]')) nodes.push(node as HTMLElement);
          else if (node.nodeType === 3 && !node.parentElement?.closest('a, pre, code, .math, .math-block, .math-inline, button')) nodes.push(node as Text);
        }
        const matches = getRenderedCitationTokens(message.content, nodes.map(node => node.nodeType === 3
          ? (node as Text).data : `[${(node as HTMLElement).dataset.llmhubCitation}]`));
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index];
          const tokens = matches[index].filter(token => byId.has(token.id));
          if (node.nodeType !== 3) continue; // Existing buttons retain their anchors across unrelated mutations.
          const text = node as Text;
          if (!tokens.length) continue;
          const fragment = doc.adoptNode(createFragment());
          let cursor = 0;
          for (const token of tokens) {
            fragment.append(doc.createTextNode(text.data.slice(cursor, token.start)));
            const button = doc.adoptNode(createEl('button'));
            button.type = 'button';
            button.className = 'llm-hub-citation-mark';
            button.dataset.llmhubCitation = String(token.id);
            button.textContent = String(token.id);
            button.title = byId.get(token.id)!.filePath;
            button.setAttribute('aria-label', `[${token.id}] ${button.title}`);
            fragment.append(button);
            cursor = token.end;
          }
          fragment.append(doc.createTextNode(text.data.slice(cursor)));
          text.replaceWith(fragment);
        }
      }
      observer.observe(root, { childList: true, subtree: true });
    };
    const observer = new Observer(decorate);
    const clicked = (event: MouseEvent) => {
      const element = event.target as Element | null;
      const button = element?.closest<HTMLElement>('[data-llmhub-citation]');
      if (!button || !root.contains(button)) return;
      const source = byId.get(Number(button.dataset.llmhubCitation));
      if (!source) return;
      if (event.type === 'dblclick') void callbacks.current.onOpen(source);
      else callbacks.current.onSelect(button, source);
    };
    root.addEventListener('click', clicked);
    root.addEventListener('dblclick', clicked);
    decorate();
    return () => {
      observer.disconnect();
      root.removeEventListener('click', clicked);
      root.removeEventListener('dblclick', clicked);
      root.querySelectorAll<HTMLElement>('[data-llmhub-citation]').forEach(button => {
        button.replaceWith(doc.createTextNode(`[${button.dataset.llmhubCitation}]`));
      });
    };
  }, [containerRef, message]);
}
