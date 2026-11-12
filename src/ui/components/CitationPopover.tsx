import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AnswerSource } from 'src/core/answerCitations';
import { t } from 'src/i18n';

interface Props {
  anchor: HTMLElement;
  source: AnswerSource;
  sources: readonly AnswerSource[];
  onClose: () => void;
  onOpen: (source: AnswerSource) => Promise<void>;
}

export function CitationPopover({ anchor, source, sources, onClose, onOpen }: Props) {
  const [all, setAll] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null), titleRef = useRef<HTMLDivElement>(null);
  const animation = useRef(0);
  const doc = anchor.ownerDocument, win = doc.defaultView;
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !win) return;
    const position = () => {
      const mark = anchor.getBoundingClientRect();
      const panel = anchor.closest('.llm-hub-chat')?.getBoundingClientRect();
      const viewport = anchor.closest('.llm-hub-messages')?.getBoundingClientRect();
      if (!anchor.isConnected || (viewport && (mark.bottom < viewport.top || mark.top > viewport.bottom))) { onClose(); return; }
      const leftEdge = Math.max(6, panel?.left ?? 6), rightEdge = Math.min(win.innerWidth - 6, panel?.right ?? win.innerWidth - 6);
      const width = Math.max(160, Math.min(400, rightEdge - leftEdge));
      card.setCssProps({ '--citation-width': `${width}px` });
      const height = card.getBoundingClientRect().height;
      const below = mark.bottom + 7;
      const top = below + height < win.innerHeight - 6 ? below : Math.max(6, mark.top - height - 7);
      card.setCssProps({ '--citation-left': `${Math.max(leftEdge, Math.min(mark.left - 8, rightEdge - width))}px`, '--citation-top': `${top}px` });
      card.addClass('is-positioned');
    };
    const outside = (event: PointerEvent) => { if (!card.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { onClose(); anchor.focus({ preventScroll: true }); } };
    const observer = new win.ResizeObserver(position);
    observer.observe(card);
    position();
    doc.addEventListener('scroll', position, true);
    doc.addEventListener('pointerdown', outside);
    // Popout windows stop Escape before it reaches document listeners.
    win.addEventListener('keydown', escape, true);
    win.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      doc.removeEventListener('scroll', position, true);
      doc.removeEventListener('pointerdown', outside);
      win.removeEventListener('keydown', escape, true);
      win.removeEventListener('resize', position);
      win.cancelAnimationFrame(animation.current);
    };
  }, [anchor, doc, win, onClose]);
  const reset = () => { win?.cancelAnimationFrame(animation.current); if (titleRef.current) titleRef.current.scrollLeft = 0; };
  const scrollPath = () => {
    reset();
    if (!win || win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = win.performance.now();
    const step = (now: number) => {
      const title = titleRef.current;
      if (!title) return;
      title.scrollLeft = Math.max(0, (now - start - 350) * 0.055);
      if (title.scrollLeft < title.scrollWidth - title.clientWidth - 1) animation.current = win.requestAnimationFrame(step);
    };
    animation.current = win.requestAnimationFrame(step);
  };
  return createPortal(<div ref={cardRef} className="llm-hub-citation-popover" role="dialog" aria-label={t('chat.citationExcerpt')}>
    <header><div ref={titleRef} tabIndex={0} className="llm-hub-citation-path" title={source.filePath}
      onMouseEnter={scrollPath} onMouseLeave={reset} onFocus={scrollPath} onBlur={reset}>{source.filePath}</div>
      <button type="button" aria-expanded={all} onClick={() => setAll(value => !value)}>{t('chat.allAnswerSources')}</button></header>
    <div className="llm-hub-citation-excerpts">{(all ? sources : [source]).map(item => <details key={item.id} open={item.id === source.id}>
      <summary>[{item.id}] {all ? item.filePath : t('chat.citationExcerpt')}{item.pageLabel ? ` · ${item.pageLabel}` : ''}</summary>
      <div className="llm-hub-citation-excerpt">{item.text}</div>
      <button type="button" onClick={() => { void onOpen(item); }}>{t('message.grounded.open')}</button>
    </details>)}</div>
  </div>, doc.body);
}
