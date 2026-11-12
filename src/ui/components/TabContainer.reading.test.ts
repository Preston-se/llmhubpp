import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const hooks = vi.hoisted(() => ({ slots: [] as Array<{ value: any }>, cursor: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = hooks.cursor++; if (!hooks.slots[index]) hooks.slots[index] = { value: initial };
    return [hooks.slots[index].value, (value: unknown) => { hooks.slots[index].value = value; }];
  }, useRef: (initial: unknown) => {
    const index = hooks.cursor++; if (!hooks.slots[index]) hooks.slots[index] = { value: { current: initial } }; return hooks.slots[index].value;
  }, useCallback: (fn: unknown) => fn,
  useImperativeHandle: (ref: { current: unknown }, create: () => unknown) => { ref.current = create(); } };
});
vi.mock("./Chat", () => ({ default: () => null }));
vi.mock("./SearchPanel", () => ({ default: () => null }));
vi.mock("./workflow/WorkflowPanel", () => ({ WorkflowPanel: () => null }));
vi.mock("src/i18n", () => ({ t: (key: string) => key }));
import TabContainer from "./TabContainer";
import Chat from "./Chat";
import SearchPanel from "./SearchPanel";

function find(node: unknown, type: unknown): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, type); if (result) return result; } return; }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return element.type === type ? element : find(element.props.children, type);
}

describe("reading actions through the tab container", () => {
  it("routes a menu search and both question modes to their real destinations", () => {
    hooks.slots = []; const ref = { current: null as any };
    const render = () => { hooks.cursor = 0; return (TabContainer as any).render({ plugin: {}, onToggleSidebarWidth: () => false }, ref); };
    let tree = render(); const prepareReadingQuestion = vi.fn();
    (find(tree, Chat) as any).ref.current = { prepareReadingQuestion };
    const context = { filePath: "学习/笔记.md", selection: "段落" };
    ref.current.searchReading(context); tree = render();
    expect(find(tree, SearchPanel)!.props.readingRequest.context).toBe(context);
    ref.current.askReading(context, false);
    ref.current.askReading(context, true);
    expect(prepareReadingQuestion.mock.calls).toEqual([[context, false], [context, true]]);
  });
});
