import { beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ effects: [] as Array<() => (() => void) | void> }));
vi.mock('react', () => ({ useEffect: (effect: () => (() => void) | void) => harness.effects.push(effect),
  useRef: (current: unknown) => ({ current }), useState: (value: unknown) => [value, vi.fn()] }));
import { useChatScroll } from './useChatScroll';
beforeEach(() => harness.effects = []);

describe('chat scroll policy', () => {
  it('holds history while streaming and resumes only through the latest action', () => {
    const element = Object.assign(new EventTarget(), { scrollTop: 900, scrollHeight: 1000, clientHeight: 100, children: [],
      ownerDocument: { defaultView: { requestAnimationFrame: (fn: () => void) => { fn(); return 1; }, cancelAnimationFrame() {} } } });
    const api = useChatScroll({ containerRef: { current: element as unknown as HTMLDivElement }, conversationKey: 'A', messages: [], streamingContent: '', streamingThinking: '' });
    const cleanup = harness.effects[0]();
    element.scrollTop = 200;
    element.dispatchEvent(new Event('scroll'));
    element.scrollHeight = 1200;
    harness.effects[1]();
    expect(element.scrollTop).toBe(200);
    api.scrollToLatest();
    expect(element.scrollTop).toBe(1200);
    cleanup?.();
  });
});
